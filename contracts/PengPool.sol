// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @title PengPool - Peer-to-peer betting contract with Chainlink ETH/USD oracle
/// @notice Players create or join games with fixed USD-equivalent bets (1, 2, 5, 10 USD in ETH).
///         The ETH/USD conversion uses a Chainlink Price Feed. The owner declares the winner;
///         95% goes to the winner and 5% to the commission wallet.
///
/// @dev    Price feed addresses:
///           - Sepolia  (testing) : 0x694AA1769357215DE4FAC081bf1f309aDC325306
///           - Abstract testnet   : Chainlink not yet deployed on Abstract testnet.
///                                  Use the Sepolia feed above for all testing.
///           - Abstract mainnet   : *** CHANGE THIS ADDRESS before mainnet deploy ***
///                                  Check https://docs.chain.link/data-feeds/price-feeds/addresses
///                                  for the official ETH/USD feed on Abstract once available.
contract PengPool {

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    enum GameStatus { OPEN, ACTIVE, FINISHED, CANCELLED }

    struct Game {
        address player1;
        address player2;
        uint256 betAmount;  // in wei, locked at creation time using oracle price
        uint8   betUSD;     // 1 | 2 | 5 | 10
        GameStatus status;
        address winner;
    }

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    /// @dev Maximum age of a Chainlink price answer before it is considered stale.
    uint256 public constant MAX_PRICE_AGE = 3600; // 1 hour

    /// @dev Tolerance applied to createGame's msg.value check, in basis points (1% = 100 bps).
    ///      Accounts for price movement between the moment the frontend quotes the amount
    ///      and the moment the transaction is mined.
    uint256 public constant PRICE_TOLERANCE_BPS = 100; // 1%

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    address public owner;
    address public commissionWallet;

    /// @notice Chainlink AggregatorV3 interface for ETH/USD price feed.
    AggregatorV3Interface public priceFeed;

    /// @notice When true, skips the Chainlink staleness check in getLatestPrice().
    /// @dev    FOR TESTNET USE ONLY. On mainnet this must remain false.
    ///         Allows testing without a live oracle update cycle.
    bool public skipStalenessCheck;

    uint256 public gameCount;
    mapping(uint256 => Game) public games;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event GameCreated(
        uint256 indexed gameId,
        address indexed player1,
        uint256 betAmount,
        uint8   betUSD
    );

    event PlayerJoined(
        uint256 indexed gameId,
        address indexed player2
    );

    event WinnerDeclared(
        uint256 indexed gameId,
        address indexed winner,
        uint256 prize,
        uint256 commission
    );

    event GameCancelled(
        uint256 indexed gameId,
        address indexed player1,
        uint256 refund
    );

    event PriceFeedUpdated(address oldFeed, address newFeed);
    event CommissionWalletUpdated(address oldWallet, address newWallet);

    // -------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------

    modifier onlyOwner() {
        require(msg.sender == owner, "PengPool: not owner");
        _;
    }

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /// @param _commissionWallet Address that receives the 5% fee on each game.
    /// @param _priceFeed        Chainlink ETH/USD AggregatorV3 address for the target network.
    ///                          Use 0x694AA1769357215DE4FAC081bf1f309aDC325306 on Sepolia for testing.
    constructor(address _commissionWallet, address _priceFeed) {
        require(_commissionWallet != address(0), "PengPool: invalid commission wallet");
        require(_priceFeed        != address(0), "PengPool: invalid price feed address");
        owner            = msg.sender;
        commissionWallet = _commissionWallet;
        priceFeed        = AggregatorV3Interface(_priceFeed);
    }

    // -------------------------------------------------------------------------
    // Oracle helpers
    // -------------------------------------------------------------------------

    /// @notice Returns the latest ETH/USD price from Chainlink, with its decimal count.
    /// @return price    Raw price value from the feed (e.g. 200000000000 for $2000, 8 decimals).
    /// @return decimals Number of decimals the price is expressed in (typically 8 for ETH/USD).
    function getLatestPrice() public view returns (int256 price, uint8 decimals) {
        (
            /* uint80 roundId */,
            int256 answer,
            /* uint256 startedAt */,
            uint256 updatedAt,
            /* uint80 answeredInRound */
        ) = priceFeed.latestRoundData();

        require(answer > 0, "PengPool: invalid oracle price");
        require(
            skipStalenessCheck || block.timestamp - updatedAt <= MAX_PRICE_AGE,
            "PengPool: stale oracle price"
        );

        return (answer, priceFeed.decimals());
    }

    /// @notice Converts a USD bet amount to its wei equivalent using the live Chainlink price.
    ///         Formula: wei = (usdAmount * 1e18 * 10^feedDecimals) / price
    /// @param  usdAmount  USD value to convert (must be 1, 2, 5, or 10).
    function betAmountWei(uint8 usdAmount) public view returns (uint256) {
        (int256 price, uint8 decimals) = getLatestPrice();
        return (uint256(usdAmount) * 1e18 * (10 ** uint256(decimals))) / uint256(price);
    }

    /// @notice Returns true if `usdAmount` is one of the allowed bet tiers.
    function isValidBet(uint8 usdAmount) public pure returns (bool) {
        return usdAmount == 1 || usdAmount == 2 || usdAmount == 5 || usdAmount == 10;
    }

    // -------------------------------------------------------------------------
    // Game actions
    // -------------------------------------------------------------------------

    /// @notice Creates a new game.
    ///         msg.value must be within ±1% of betAmountWei(betUSD) to absorb
    ///         minor price fluctuations between quote and tx execution.
    ///         The actual wei sent is stored as the game's betAmount.
    /// @param  betUSD  Bet size in USD: 1, 2, 5, or 10.
    /// @return gameId  ID of the newly created game.
    function createGame(uint8 betUSD) external payable returns (uint256 gameId) {
        require(isValidBet(betUSD), "PengPool: bet must be 1, 2, 5, or 10 USD");

        uint256 expected  = betAmountWei(betUSD);
        uint256 tolerance = expected * PRICE_TOLERANCE_BPS / 10000;
        uint256 minAccepted = expected > tolerance ? expected - tolerance : 0;

        require(
            msg.value >= minAccepted && msg.value <= expected + tolerance,
            "PengPool: ETH amount out of range for chosen USD bet"
        );

        gameId = gameCount;
        gameCount++;

        games[gameId] = Game({
            player1:   msg.sender,
            player2:   address(0),
            betAmount: msg.value,   // exact wei sent by player1, player2 must match this
            betUSD:    betUSD,
            status:    GameStatus.OPEN,
            winner:    address(0)
        });

        emit GameCreated(gameId, msg.sender, msg.value, betUSD);
    }

    /// @notice Joins an open game. msg.value must match the game's stored betAmount exactly.
    ///         Query getGame(gameId).betAmount to know the exact wei required.
    /// @param  gameId  ID of the game to join.
    function joinGame(uint256 gameId) external payable {
        Game storage game = games[gameId];
        require(game.status == GameStatus.OPEN,   "PengPool: game not open");
        require(game.player1 != msg.sender,        "PengPool: cannot join own game");
        require(msg.value == game.betAmount,       "PengPool: must match game's exact bet amount");

        game.player2 = msg.sender;
        game.status  = GameStatus.ACTIVE;

        emit PlayerJoined(gameId, msg.sender);
    }

    /// @notice Owner declares the winner of an active game.
    ///         Winner receives 95% of the pot; commissionWallet receives 5%.
    /// @param  gameId  ID of the finished game.
    /// @param  winner  Address of the winner (must be player1 or player2).
    function declareWinner(uint256 gameId, address winner) external onlyOwner {
        Game storage game = games[gameId];
        require(game.status == GameStatus.ACTIVE,                          "PengPool: game not active");
        require(winner == game.player1 || winner == game.player2,          "PengPool: invalid winner address");

        game.winner = winner;
        game.status = GameStatus.FINISHED;

        uint256 pot        = game.betAmount * 2;
        uint256 commission = pot * 5 / 100;
        uint256 prize      = pot - commission;

        (bool sentPrize, )      = winner.call{value: prize}("");
        require(sentPrize, "PengPool: prize transfer failed");

        (bool sentCommission, ) = commissionWallet.call{value: commission}("");
        require(sentCommission, "PengPool: commission transfer failed");

        emit WinnerDeclared(gameId, winner, prize, commission);
    }

    /// @notice Player1 cancels their own OPEN game and recovers the full bet.
    ///         Only available while no second player has joined.
    /// @param  gameId  ID of the game to cancel.
    function cancelGame(uint256 gameId) external {
        Game storage game = games[gameId];
        require(game.status == GameStatus.OPEN,  "PengPool: game not open");
        require(game.player1 == msg.sender,       "PengPool: not game creator");

        game.status = GameStatus.CANCELLED;
        uint256 refund = game.betAmount;

        (bool sent, ) = game.player1.call{value: refund}("");
        require(sent, "PengPool: refund transfer failed");

        emit GameCancelled(gameId, game.player1, refund);
    }

    // -------------------------------------------------------------------------
    // Owner admin
    // -------------------------------------------------------------------------

    /// @notice Updates the Chainlink price feed address (e.g., when switching networks).
    /// @param  newFeed  Address of the new AggregatorV3 price feed.
    function setPriceFeed(address newFeed) external onlyOwner {
        require(newFeed != address(0), "PengPool: invalid address");
        emit PriceFeedUpdated(address(priceFeed), newFeed);
        priceFeed = AggregatorV3Interface(newFeed);
    }

    /// @notice Toggles the staleness check bypass.
    /// @dev    FOR TESTNET USE ONLY. Never enable on mainnet.
    /// @param  enabled  true to skip staleness check, false to enforce it.
    function setSkipStalenessCheck(bool enabled) external onlyOwner {
        skipStalenessCheck = enabled;
    }

    /// @notice Updates the wallet that receives the 5% commission.
    /// @param  newWallet  New commission wallet address.
    function setCommissionWallet(address newWallet) external onlyOwner {
        require(newWallet != address(0), "PengPool: invalid address");
        emit CommissionWalletUpdated(commissionWallet, newWallet);
        commissionWallet = newWallet;
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /// @notice Returns the full data of a game.
    function getGame(uint256 gameId) external view returns (Game memory) {
        return games[gameId];
    }

    /// @notice Returns the IDs of all OPEN games (available to join).
    function getOpenGames() external view returns (uint256[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < gameCount; i++) {
            if (games[i].status == GameStatus.OPEN) count++;
        }
        uint256[] memory result = new uint256[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < gameCount; i++) {
            if (games[i].status == GameStatus.OPEN) result[idx++] = i;
        }
        return result;
    }
}
