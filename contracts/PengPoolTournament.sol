// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @title PengPoolTournament — Multi-player tournament escrow with prize distribution
/// @notice Owner (server) creates and manages tournaments. Players register by paying
///         the buy-in. Winners claim prizes via pull pattern after distributePrizes().
contract PengPoolTournament is Ownable, ReentrancyGuard {

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    enum TournamentStatus { REGISTRATION, ACTIVE, FINISHED, CANCELLED }

    struct Tournament {
        string           name;
        uint256          buyInUSD;
        uint256          startTime;
        TournamentStatus status;
        uint256          participantCount;
        uint256          prizePoolETH;
        bool             isCustom;
        address          creator;
        uint256          distributedAt;
    }

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    uint256 public constant COMMISSION_BPS = 1000;  // 10%
    uint256 public constant SLIPPAGE_BPS   = 200;   // 2%
    uint256 public constant CLAIM_EXPIRY   = 24 hours;
    uint256 public constant MAX_PRICE_AGE  = 3600;  // 1 hour

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    AggregatorV3Interface public priceFeed;
    address               public commissionWallet;
    bool                  public skipStalenessCheck;

    uint256 public tournamentCount;

    mapping(uint256 => Tournament)                      public tournaments;
    mapping(uint256 => mapping(address => uint256))     public playerDeposits;
    mapping(uint256 => mapping(address => uint256))     public pendingPrizes;
    mapping(uint256 => mapping(address => bool))        public isRegistered;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event TournamentCreated(
        uint256 indexed tournamentId,
        string name,
        uint256 buyInUSD,
        uint256 startTime,
        bool isCustom,
        address creator
    );
    event PlayerRegistered(
        uint256 indexed tournamentId,
        address indexed player,
        uint256 ethAmount
    );
    event TournamentStarted(
        uint256 indexed tournamentId,
        uint256 participantCount
    );
    event MatchWinner(
        uint256 indexed tournamentId,
        uint256 indexed matchId,
        address winner
    );
    event PrizesDistributed(
        uint256 indexed tournamentId,
        uint256 totalPrize,
        address[] winners
    );
    event PrizeClaimed(
        uint256 indexed tournamentId,
        address indexed player,
        uint256 amount
    );
    event ExpiredPrizeClaimed(
        uint256 indexed tournamentId,
        address indexed player,
        uint256 amount
    );

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /// @param _priceFeed        Chainlink ETH/USD AggregatorV3 address.
    /// @param _commissionWallet Address that receives the 10% commission.
    constructor(address _priceFeed, address _commissionWallet) {
        require(_priceFeed        != address(0), "PengPoolTournament: invalid price feed");
        require(_commissionWallet != address(0), "PengPoolTournament: invalid commission wallet");
        priceFeed        = AggregatorV3Interface(_priceFeed);
        commissionWallet = _commissionWallet;
    }

    // -------------------------------------------------------------------------
    // Oracle helpers
    // -------------------------------------------------------------------------

    /// @notice Returns the latest ETH/USD price and its decimal precision.
    function getLatestPrice() public view returns (int256 price, uint8 decimals) {
        (, int256 answer, , uint256 updatedAt, ) = priceFeed.latestRoundData();
        require(answer > 0, "PengPoolTournament: invalid oracle price");
        require(
            skipStalenessCheck || block.timestamp - updatedAt <= MAX_PRICE_AGE,
            "PengPoolTournament: stale oracle price"
        );
        return (answer, priceFeed.decimals());
    }

    /// @notice Converts a USD amount to the equivalent wei value.
    function buyInAmountWei(uint256 usdAmount) public view returns (uint256) {
        (int256 price, uint8 decimals) = getLatestPrice();
        return (usdAmount * 1e18 * (10 ** uint256(decimals))) / uint256(price);
    }

    // -------------------------------------------------------------------------
    // Tournament creation
    // -------------------------------------------------------------------------

    /// @notice Creates a new tournament. Only callable by owner (server).
    /// @param name       Human-readable tournament name.
    /// @param buyInUSD   Buy-in amount in USD: must be 1, 2, or 5.
    /// @param startTime  Unix timestamp when registration closes and tournament starts.
    /// @param isCustom   False = Regular (buy-in must be $2). True = Custom.
    /// @param creator    Wallet of the organizer (for attribution; may be any address).
    /// @return tournamentId Auto-incremented tournament ID starting at 1.
    function createTournament(
        string calldata name,
        uint256 buyInUSD,
        uint256 startTime,
        bool isCustom,
        address creator
    ) external onlyOwner returns (uint256 tournamentId) {
        require(
            buyInUSD == 0 || buyInUSD == 1 || buyInUSD == 2 || buyInUSD == 5,
            "PengPoolTournament: buy-in must be 0, 1, 2, or 5 USD"
        );
        if (!isCustom) {
            require(buyInUSD == 2, "PengPoolTournament: regular tournament buy-in must be 2 USD");
        }
        require(creator   != address(0),      "PengPoolTournament: invalid creator address");
        require(startTime >  block.timestamp,  "PengPoolTournament: start time must be in the future");

        tournamentCount++;
        tournamentId = tournamentCount;

        tournaments[tournamentId] = Tournament({
            name:             name,
            buyInUSD:         buyInUSD,
            startTime:        startTime,
            status:           TournamentStatus.REGISTRATION,
            participantCount: 0,
            prizePoolETH:     0,
            isCustom:         isCustom,
            creator:          creator,
            distributedAt:    0
        });

        emit TournamentCreated(tournamentId, name, buyInUSD, startTime, isCustom, creator);
    }

    // -------------------------------------------------------------------------
    // Player registration
    // -------------------------------------------------------------------------

    /// @notice Register and pay the buy-in for a tournament. Called directly by the player.
    /// @param tournamentId ID of the tournament to join.
    function registerPlayer(uint256 tournamentId) external payable nonReentrant {
        Tournament storage t = tournaments[tournamentId];
        require(
            t.status == TournamentStatus.REGISTRATION,
            "PengPoolTournament: tournament is not open for registration"
        );
        require(
            block.timestamp < t.startTime,
            "PengPoolTournament: registration period has ended"
        );
        require(
            !isRegistered[tournamentId][msg.sender],
            "PengPoolTournament: player already registered"
        );

        if (t.buyInUSD == 0) {
            require(msg.value == 0, "PengPoolTournament: free tournament requires no ETH");
        } else {
            uint256 baseAmount = buyInAmountWei(t.buyInUSD);
            uint256 maxAmount  = baseAmount + (baseAmount * SLIPPAGE_BPS / 10000);
            require(msg.value >= baseAmount, "PengPoolTournament: insufficient ETH sent");
            require(msg.value <= maxAmount,  "PengPoolTournament: ETH amount exceeds slippage tolerance");
        }

        isRegistered[tournamentId][msg.sender]     = true;
        playerDeposits[tournamentId][msg.sender]   = msg.value;

        t.participantCount++;
        t.prizePoolETH += msg.value;

        emit PlayerRegistered(tournamentId, msg.sender, msg.value);
    }

    // -------------------------------------------------------------------------
    // Tournament lifecycle — owner only
    // -------------------------------------------------------------------------

    /// @notice Moves a tournament from REGISTRATION to ACTIVE.
    /// @param tournamentId ID of the tournament to start.
    function startTournament(uint256 tournamentId) external onlyOwner {
        Tournament storage t = tournaments[tournamentId];
        require(
            t.status == TournamentStatus.REGISTRATION,
            "PengPoolTournament: tournament is not in registration status"
        );
        require(
            t.participantCount >= 2,
            "PengPoolTournament: at least 2 players required to start"
        );

        t.status = TournamentStatus.ACTIVE;

        emit TournamentStarted(tournamentId, t.participantCount);
    }

    /// @notice Records the result of a single match within an active tournament.
    /// @param tournamentId ID of the tournament.
    /// @param matchId      Server-side match identifier.
    /// @param winner       Address of the match winner.
    function declareMatchWinner(
        uint256 tournamentId,
        uint256 matchId,
        address winner
    ) external onlyOwner {
        require(
            tournaments[tournamentId].status == TournamentStatus.ACTIVE,
            "PengPoolTournament: tournament is not active"
        );
        require(winner != address(0), "PengPoolTournament: invalid winner address");

        emit MatchWinner(tournamentId, matchId, winner);
    }

    /// @notice Finalises the tournament and records each winner's claimable prize.
    ///         10% of the total prize pool is sent immediately to the commission wallet.
    ///         The remaining 90% is split among winners according to `percentages`.
    /// @param tournamentId ID of the tournament.
    /// @param winners      Ordered list of prize-eligible addresses.
    /// @param percentages  Each winner's share of the 90% prize pool, expressed as integer
    ///                     percentages out of 100. Must sum to 100.
    function distributePrizes(
        uint256 tournamentId,
        address[] calldata winners,
        uint256[] calldata percentages
    ) external onlyOwner {
        Tournament storage t = tournaments[tournamentId];
        require(
            t.status == TournamentStatus.ACTIVE,
            "PengPoolTournament: tournament is not active"
        );
        require(winners.length > 0,                         "PengPoolTournament: no winners provided");
        require(winners.length == percentages.length,       "PengPoolTournament: winners and percentages length mismatch");

        uint256 totalPct;
        for (uint256 i = 0; i < percentages.length; i++) {
            totalPct += percentages[i];
        }
        require(totalPct == 100, "PengPoolTournament: percentages must sum to 100");

        uint256 totalPrize  = t.prizePoolETH;

        // Free tournament — no ETH to distribute; just mark as finished
        if (totalPrize == 0) {
            t.status        = TournamentStatus.FINISHED;
            t.distributedAt = block.timestamp;
            emit PrizesDistributed(tournamentId, 0, winners);
            return;
        }

        uint256 commission  = totalPrize * COMMISSION_BPS / 10000;
        uint256 prizePool   = totalPrize - commission;  // guaranteed 90% of total

        // Transfer commission immediately
        (bool commSent, ) = commissionWallet.call{value: commission}("");
        require(commSent, "PengPoolTournament: commission transfer failed");

        // Record each winner's claimable share; last winner absorbs any rounding dust
        uint256 distributed;
        for (uint256 i = 0; i < winners.length - 1; i++) {
            require(winners[i] != address(0), "PengPoolTournament: invalid winner address");
            uint256 prize = prizePool * percentages[i] / 100;
            pendingPrizes[tournamentId][winners[i]] += prize;
            distributed += prize;
        }
        // Last winner
        address lastWinner = winners[winners.length - 1];
        require(lastWinner != address(0), "PengPoolTournament: invalid winner address");
        pendingPrizes[tournamentId][lastWinner] += prizePool - distributed;

        t.status        = TournamentStatus.FINISHED;
        t.distributedAt = block.timestamp;

        emit PrizesDistributed(tournamentId, totalPrize, winners);
    }

    // -------------------------------------------------------------------------
    // Prize claiming — player
    // -------------------------------------------------------------------------

    /// @notice Claim a pending prize from a finished tournament. Called by the winner.
    /// @param tournamentId ID of the finished tournament.
    function claimPrize(uint256 tournamentId) external nonReentrant {
        require(
            tournaments[tournamentId].status == TournamentStatus.FINISHED,
            "PengPoolTournament: tournament is not finished"
        );

        uint256 prize = pendingPrizes[tournamentId][msg.sender];
        require(prize > 0, "PengPoolTournament: no pending prize");

        pendingPrizes[tournamentId][msg.sender] = 0;

        (bool sent, ) = msg.sender.call{value: prize}("");
        require(sent, "PengPoolTournament: prize transfer failed");

        emit PrizeClaimed(tournamentId, msg.sender, prize);
    }

    // -------------------------------------------------------------------------
    // Expired claim recovery — owner only
    // -------------------------------------------------------------------------

    /// @notice Recovers a prize that has not been claimed 24h after distributePrizes().
    ///         Sends the unclaimed amount to the commission wallet.
    /// @param tournamentId ID of the finished tournament.
    /// @param player       Address whose unclaimed prize is being recovered.
    function expiredPrizeClaim(uint256 tournamentId, address player) external onlyOwner {
        Tournament storage t = tournaments[tournamentId];
        require(
            t.status == TournamentStatus.FINISHED,
            "PengPoolTournament: tournament is not finished"
        );
        require(
            t.distributedAt > 0,
            "PengPoolTournament: prizes have not been distributed"
        );
        require(
            block.timestamp >= t.distributedAt + CLAIM_EXPIRY,
            "PengPoolTournament: claim period has not expired yet"
        );

        uint256 prize = pendingPrizes[tournamentId][player];
        require(prize > 0, "PengPoolTournament: no pending prize for this player");

        pendingPrizes[tournamentId][player] = 0;

        (bool sent, ) = commissionWallet.call{value: prize}("");
        require(sent, "PengPoolTournament: expired prize transfer failed");

        emit ExpiredPrizeClaimed(tournamentId, player, prize);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /// @notice Returns full information about a tournament.
    function getTournamentInfo(uint256 tournamentId)
        external
        view
        returns (
            string memory name,
            uint256 buyInUSD,
            uint256 startTime,
            TournamentStatus status,
            uint256 participantCount,
            uint256 prizePool,
            bool isCustom,
            address creator
        )
    {
        Tournament storage t = tournaments[tournamentId];
        return (
            t.name,
            t.buyInUSD,
            t.startTime,
            t.status,
            t.participantCount,
            t.prizePoolETH,
            t.isCustom,
            t.creator
        );
    }

    /// @notice Returns the ETH deposit made by a player in a tournament (0 if not registered).
    function getPlayerDeposit(uint256 tournamentId, address player)
        external
        view
        returns (uint256)
    {
        return playerDeposits[tournamentId][player];
    }

    /// @notice Returns the unclaimed prize amount for a player in a tournament.
    function getPendingPrize(uint256 tournamentId, address player)
        external
        view
        returns (uint256)
    {
        return pendingPrizes[tournamentId][player];
    }

    // -------------------------------------------------------------------------
    // Admin setters
    // -------------------------------------------------------------------------

    function setPriceFeed(address newFeed) external onlyOwner {
        require(newFeed != address(0), "PengPoolTournament: invalid address");
        priceFeed = AggregatorV3Interface(newFeed);
    }

    function setCommissionWallet(address newWallet) external onlyOwner {
        require(newWallet != address(0), "PengPoolTournament: invalid address");
        commissionWallet = newWallet;
    }

    function setSkipStalenessCheck(bool enabled) external onlyOwner {
        skipStalenessCheck = enabled;
    }
}
