// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/// @title PengPoolV2 - Escrow-based matchmaking with claim pattern
/// @notice Players deposit their bet when entering the matchmaking queue.
///         A trusted matchmaker (server wallet) pairs two players and creates a match.
///         The winner claims their prize explicitly; unclaimed prizes expire after 24h.
contract PengPoolV2 is ReentrancyGuard {

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    enum MatchStatus { ACTIVE, FINISHED }

    struct Deposit {
        uint256 amount;   // wei deposited
        uint8   betUSD;   // 1 | 5
        bool    matched;  // true once matchPlayers() consumes this deposit
    }

    struct Match {
        address player1;
        address player2;
        uint256 betAmount;   // wei per player (from deposit)
        uint8   betUSD;
        MatchStatus status;
        address winner;
        uint256 declaredAt;  // timestamp of declareWinner()
    }

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    uint256 public constant MAX_PRICE_AGE       = 3600;  // 1 hour
    uint256 public constant PRICE_TOLERANCE_BPS = 100;   // 1%
    uint256 public constant CLAIM_EXPIRY        = 24 hours;
    uint256 public constant COMMISSION_BPS      = 1000;  // 10%

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    address public owner;
    address public matchmaker;
    address public commissionWallet;

    AggregatorV3Interface public priceFeed;
    bool public skipStalenessCheck;

    mapping(address => Deposit) public deposits;

    uint256 public matchCount;
    mapping(uint256 => Match) public matches;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event Deposited(address indexed player, uint256 amount, uint8 betUSD);
    event DepositWithdrawn(address indexed player, uint256 amount);
    event MatchCreated(uint256 indexed matchId, address indexed player1, address indexed player2, uint256 betAmount, uint8 betUSD);
    event WinnerDeclared(uint256 indexed matchId, address indexed winner);
    event WinningsClaimed(uint256 indexed matchId, address indexed winner, uint256 prize, uint256 commission);
    event ExpiredClaimRecovered(uint256 indexed matchId, uint256 amount);
    event PriceFeedUpdated(address oldFeed, address newFeed);
    event CommissionWalletUpdated(address oldWallet, address newWallet);
    event MatchmakerUpdated(address oldMaker, address newMaker);
    event MatchCancelled(uint256 indexed matchId, address player1, address player2, uint256 amount);

    // -------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------

    modifier onlyOwner() {
        require(msg.sender == owner, "PengPoolV2: not owner");
        _;
    }

    modifier onlyMatchmaker() {
        require(msg.sender == matchmaker, "PengPoolV2: not matchmaker");
        _;
    }

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /// @param _commissionWallet Address that receives the 10% fee.
    /// @param _matchmaker       Server wallet authorized to call matchPlayers and declareWinner.
    /// @param _priceFeed        Chainlink ETH/USD AggregatorV3 address.
    constructor(address _commissionWallet, address _matchmaker, address _priceFeed) {
        require(_commissionWallet != address(0), "PengPoolV2: invalid commission wallet");
        require(_matchmaker       != address(0), "PengPoolV2: invalid matchmaker");
        require(_priceFeed        != address(0), "PengPoolV2: invalid price feed");
        owner            = msg.sender;
        commissionWallet = _commissionWallet;
        matchmaker       = _matchmaker;
        priceFeed        = AggregatorV3Interface(_priceFeed);
    }

    // -------------------------------------------------------------------------
    // Oracle helpers
    // -------------------------------------------------------------------------

    function getLatestPrice() public view returns (int256 price, uint8 decimals) {
        (,int256 answer,,uint256 updatedAt,) = priceFeed.latestRoundData();
        require(answer > 0, "PengPoolV2: invalid oracle price");
        require(
            skipStalenessCheck || block.timestamp - updatedAt <= MAX_PRICE_AGE,
            "PengPoolV2: stale oracle price"
        );
        return (answer, priceFeed.decimals());
    }

    function betAmountWei(uint8 usdAmount) public view returns (uint256) {
        (int256 price, uint8 decimals) = getLatestPrice();
        return (uint256(usdAmount) * 1e18 * (10 ** uint256(decimals))) / uint256(price);
    }

    function isValidBet(uint8 usdAmount) public pure returns (bool) {
        return usdAmount == 1 || usdAmount == 5;
    }

    // -------------------------------------------------------------------------
    // Player actions
    // -------------------------------------------------------------------------

    /// @notice Deposit bet to enter matchmaking queue (user gesture — no popup block).
    /// @param  betUSD  Bet size in USD: 1 or 5.
    function deposit(uint8 betUSD) external payable {
        require(isValidBet(betUSD), "PengPoolV2: bet must be 1 or 5 USD");
        require(!deposits[msg.sender].matched, "PengPoolV2: already in a match");
        require(deposits[msg.sender].amount == 0, "PengPoolV2: existing deposit - withdraw first");

        uint256 expected    = betAmountWei(betUSD);
        uint256 tolerance   = expected * PRICE_TOLERANCE_BPS / 10000;
        uint256 minAccepted = expected > tolerance ? expected - tolerance : 0;

        require(
            msg.value >= minAccepted && msg.value <= expected + tolerance,
            "PengPoolV2: ETH amount out of range"
        );

        deposits[msg.sender] = Deposit({ amount: msg.value, betUSD: betUSD, matched: false });
        emit Deposited(msg.sender, msg.value, betUSD);
    }

    /// @notice Withdraw deposit if not yet matched. Cancels queue entry.
    function withdrawDeposit() external nonReentrant {
        Deposit storage dep = deposits[msg.sender];
        require(dep.amount > 0,  "PengPoolV2: no deposit");
        require(!dep.matched,    "PengPoolV2: already matched - cannot withdraw");

        uint256 amount = dep.amount;
        delete deposits[msg.sender];

        (bool sent,) = msg.sender.call{value: amount}("");
        require(sent, "PengPoolV2: withdraw failed");

        emit DepositWithdrawn(msg.sender, amount);
    }

    /// @notice Winner claims their prize after declareWinner().
    /// @param  matchId  ID of the finished match.
    function claimWinnings(uint256 matchId) external nonReentrant {
        Match storage m = matches[matchId];
        require(m.status == MatchStatus.FINISHED, "PengPoolV2: match not finished");
        require(m.winner == msg.sender,            "PengPoolV2: not the winner");
        require(m.betAmount > 0,                   "PengPoolV2: already claimed");

        uint256 pot        = m.betAmount * 2;
        uint256 commission = pot * COMMISSION_BPS / 10000;
        uint256 prize      = pot - commission;
        m.betAmount = 0; // mark as claimed

        (bool sentPrize,)      = msg.sender.call{value: prize}("");
        require(sentPrize, "PengPoolV2: prize transfer failed");

        (bool sentCommission,) = commissionWallet.call{value: commission}("");
        require(sentCommission, "PengPoolV2: commission transfer failed");

        emit WinningsClaimed(matchId, msg.sender, prize, commission);
    }

    // -------------------------------------------------------------------------
    // Matchmaker actions
    // -------------------------------------------------------------------------

    /// @notice Creates a match between two deposited players.
    ///         Called by the server matchmaker wallet — no ETH required from players.
    /// @param  addr1   Address of player 1.
    /// @param  addr2   Address of player 2.
    /// @param  betUSD  Expected bet tier — must match both deposits.
    /// @return matchId ID of the newly created match.
    function matchPlayers(address addr1, address addr2, uint8 betUSD) external onlyMatchmaker nonReentrant returns (uint256 matchId) {
        require(addr1 != addr2, "PengPoolV2: cannot match player with themselves");

        Deposit storage dep1 = deposits[addr1];
        Deposit storage dep2 = deposits[addr2];

        require(dep1.amount > 0 && !dep1.matched, "PengPoolV2: player1 has no valid deposit");
        require(dep2.amount > 0 && !dep2.matched, "PengPoolV2: player2 has no valid deposit");
        require(dep1.betUSD == betUSD && dep2.betUSD == betUSD, "PengPoolV2: bet tier mismatch");

        // Use the smaller deposit as betAmount — refund any excess
        uint256 betAmount = dep1.amount < dep2.amount ? dep1.amount : dep2.amount;

        if (dep1.amount > betAmount) {
            uint256 excess = dep1.amount - betAmount;
            dep1.amount = betAmount;
            (bool r1,) = addr1.call{value: excess}("");
            require(r1, "PengPoolV2: excess refund p1 failed");
        }
        if (dep2.amount > betAmount) {
            uint256 excess = dep2.amount - betAmount;
            dep2.amount = betAmount;
            (bool r2,) = addr2.call{value: excess}("");
            require(r2, "PengPoolV2: excess refund p2 failed");
        }

        dep1.matched = true;
        dep2.matched = true;

        matchId = matchCount++;
        matches[matchId] = Match({
            player1:    addr1,
            player2:    addr2,
            betAmount:  betAmount,
            betUSD:     betUSD,
            status:     MatchStatus.ACTIVE,
            winner:     address(0),
            declaredAt: 0
        });

        emit MatchCreated(matchId, addr1, addr2, betAmount, betUSD);
    }

    /// @notice Declares the winner of an active match. Does not transfer ETH.
    ///         Winner must call claimWinnings() to receive their prize.
    /// @param  matchId  ID of the match.
    /// @param  winner   Address of the winner (must be player1 or player2).
    function declareWinner(uint256 matchId, address winner) external onlyMatchmaker {
        Match storage m = matches[matchId];
        require(m.status == MatchStatus.ACTIVE,                    "PengPoolV2: match not active");
        require(winner == m.player1 || winner == m.player2,        "PengPoolV2: invalid winner");

        m.winner     = winner;
        m.status     = MatchStatus.FINISHED;
        m.declaredAt = block.timestamp;

        delete deposits[m.player1];
        delete deposits[m.player2];

        emit WinnerDeclared(matchId, winner);
    }

    /// @notice Cancels an active match and refunds both players their bet.
    ///         Used to resolve orphaned matches after a server restart.
    /// @param  matchId  ID of the match to cancel.
    function cancelMatch(uint256 matchId) external onlyMatchmaker nonReentrant {
        Match storage m = matches[matchId];
        require(m.status == MatchStatus.ACTIVE, "Match not active");
        require(m.betAmount > 0, "No funds to return");

        uint256 amount = m.betAmount;
        m.betAmount = 0;
        m.status = MatchStatus.FINISHED;
        m.winner = address(0);

        delete deposits[m.player1];
        delete deposits[m.player2];

        (bool s1,) = m.player1.call{value: amount}("");
        (bool s2,) = m.player2.call{value: amount}("");
        require(s1 && s2, "Refund failed");

        emit MatchCancelled(matchId, m.player1, m.player2, amount);
    }

    // -------------------------------------------------------------------------
    // Owner admin
    // -------------------------------------------------------------------------

    /// @notice Recovers unclaimed winnings after 24h expiry.
    ///         Sends full pot to commissionWallet — owner cannot pocket funds directly.
    /// @param  matchId  ID of the expired match.
    function expiredClaim(uint256 matchId) external onlyOwner {
        Match storage m = matches[matchId];
        require(m.status == MatchStatus.FINISHED,               "PengPoolV2: match not finished");
        require(m.betAmount > 0,                                 "PengPoolV2: already claimed");
        require(block.timestamp >= m.declaredAt + CLAIM_EXPIRY, "PengPoolV2: not expired yet");

        uint256 amount = m.betAmount * 2;
        m.betAmount = 0;

        (bool sent,) = commissionWallet.call{value: amount}("");
        require(sent, "PengPoolV2: expired claim transfer failed");

        emit ExpiredClaimRecovered(matchId, amount);
    }

    function setPriceFeed(address newFeed) external onlyOwner {
        require(newFeed != address(0), "PengPoolV2: invalid address");
        emit PriceFeedUpdated(address(priceFeed), newFeed);
        priceFeed = AggregatorV3Interface(newFeed);
    }

    function setSkipStalenessCheck(bool enabled) external onlyOwner {
        skipStalenessCheck = enabled;
    }

    function setCommissionWallet(address newWallet) external onlyOwner {
        require(newWallet != address(0), "PengPoolV2: invalid address");
        emit CommissionWalletUpdated(commissionWallet, newWallet);
        commissionWallet = newWallet;
    }

    function setMatchmaker(address newMaker) external onlyOwner {
        require(newMaker != address(0), "PengPoolV2: invalid address");
        emit MatchmakerUpdated(matchmaker, newMaker);
        matchmaker = newMaker;
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function getMatch(uint256 matchId) external view returns (Match memory) {
        return matches[matchId];
    }

    function getDeposit(address player) external view returns (Deposit memory) {
        return deposits[player];
    }
}
