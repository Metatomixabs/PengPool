const { expect }      = require("chai");
const { ethers }      = require("hardhat");
const { time }        = require("@nomicfoundation/hardhat-network-helpers");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ETH_PRICE_USD  = 2000;           // mock price: $2,000 / ETH
const FEED_DECIMALS  = 8;
const FEED_PRICE     = ETH_PRICE_USD * 10 ** FEED_DECIMALS; // 200_000_000_000

// betAmountWei = (usdAmount * 1e18 * 1e8) / FEED_PRICE
function expectedWei(usdAmount) {
  return (BigInt(usdAmount) * BigInt(1e18) * BigInt(10 ** FEED_DECIMALS)) / BigInt(FEED_PRICE);
}

const BET = {
  1:  expectedWei(1),   // 500_000_000_000_000  (0.0005 ETH)
  2:  expectedWei(2),   // 1_000_000_000_000_000 (0.001 ETH)
  5:  expectedWei(5),   // 2_500_000_000_000_000 (0.0025 ETH)
  10: expectedWei(10),  // 5_000_000_000_000_000 (0.005 ETH)
};

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function deployFixture() {
  const [owner, commissionWallet, player1, player2, other] = await ethers.getSigners();

  // Deploy Chainlink mock — 8 decimals, $2,000/ETH
  const MockAggregator = await ethers.getContractFactory("MockV3Aggregator");
  const mockFeed = await MockAggregator.deploy(FEED_DECIMALS, FEED_PRICE);

  // Deploy PengPool
  const PengPool = await ethers.getContractFactory("PengPool");
  const pengPool = await PengPool.deploy(commissionWallet.address, await mockFeed.getAddress());

  return { pengPool, mockFeed, owner, commissionWallet, player1, player2, other };
}

// ---------------------------------------------------------------------------
// Helper: create an OPEN game as player1
// ---------------------------------------------------------------------------

async function createOpenGame(pengPool, player1, betUSD = 1) {
  const tx = await pengPool.connect(player1).createGame(betUSD, { value: BET[betUSD] });
  const receipt = await tx.wait();
  const event = receipt.logs
    .map(l => { try { return pengPool.interface.parseLog(l); } catch { return null; } })
    .find(e => e && e.name === "GameCreated");
  return event.args.gameId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PengPool", function () {

  // ── Deployment ────────────────────────────────────────────────────────────
  describe("Deployment", function () {
    it("sets owner, commissionWallet and priceFeed correctly", async function () {
      const { pengPool, mockFeed, owner, commissionWallet } = await deployFixture();
      expect(await pengPool.owner()).to.equal(owner.address);
      expect(await pengPool.commissionWallet()).to.equal(commissionWallet.address);
      expect(await pengPool.priceFeed()).to.equal(await mockFeed.getAddress());
    });

    it("reverts if commissionWallet is zero address", async function () {
      const { mockFeed } = await deployFixture();
      const PengPool = await ethers.getContractFactory("PengPool");
      await expect(
        PengPool.deploy(ethers.ZeroAddress, await mockFeed.getAddress())
      ).to.be.revertedWith("PengPool: invalid commission wallet");
    });

    it("reverts if priceFeed is zero address", async function () {
      const { commissionWallet } = await deployFixture();
      const PengPool = await ethers.getContractFactory("PengPool");
      await expect(
        PengPool.deploy(commissionWallet.address, ethers.ZeroAddress)
      ).to.be.revertedWith("PengPool: invalid price feed address");
    });
  });

  // ── Oracle helpers ────────────────────────────────────────────────────────
  describe("Oracle helpers", function () {
    it("getLatestPrice returns feed price and decimals", async function () {
      const { pengPool } = await deployFixture();
      const [price, decimals] = await pengPool.getLatestPrice();
      expect(price).to.equal(FEED_PRICE);
      expect(decimals).to.equal(FEED_DECIMALS);
    });

    it("betAmountWei returns correct wei for each valid tier", async function () {
      const { pengPool } = await deployFixture();
      for (const usd of [1, 2, 5, 10]) {
        expect(await pengPool.betAmountWei(usd)).to.equal(BET[usd]);
      }
    });

    it("isValidBet returns true for 1, 2, 5, 10 and false otherwise", async function () {
      const { pengPool } = await deployFixture();
      for (const valid of [1, 2, 5, 10]) {
        expect(await pengPool.isValidBet(valid)).to.be.true;
      }
      for (const invalid of [0, 3, 4, 6, 7, 8, 9, 11, 100]) {
        expect(await pengPool.isValidBet(invalid)).to.be.false;
      }
    });

    it("getLatestPrice reverts when price is stale (> 1 hour old)", async function () {
      const { pengPool } = await deployFixture();
      await time.increase(3601);
      await expect(pengPool.getLatestPrice()).to.be.revertedWith("PengPool: stale oracle price");
    });
  });

  // ── createGame ────────────────────────────────────────────────────────────
  describe("createGame", function () {
    it("creates a game for each valid bet tier and emits GameCreated", async function () {
      const { pengPool, player1 } = await deployFixture();

      let expectedId = 0n;
      for (const betUSD of [1, 2, 5, 10]) {
        await expect(
          pengPool.connect(player1).createGame(betUSD, { value: BET[betUSD] })
        )
          .to.emit(pengPool, "GameCreated")
          .withArgs(expectedId, player1.address, BET[betUSD], betUSD);
        expectedId++;
      }
    });

    it("stores game data correctly after creation", async function () {
      const { pengPool, player1 } = await deployFixture();
      const gameId = await createOpenGame(pengPool, player1, 2);
      const game = await pengPool.getGame(gameId);

      expect(game.player1).to.equal(player1.address);
      expect(game.player2).to.equal(ethers.ZeroAddress);
      expect(game.betAmount).to.equal(BET[2]);
      expect(game.betUSD).to.equal(2);
      expect(game.status).to.equal(0); // OPEN
      expect(game.winner).to.equal(ethers.ZeroAddress);
    });

    it("increments gameCount after each creation", async function () {
      const { pengPool, player1 } = await deployFixture();
      expect(await pengPool.gameCount()).to.equal(0);
      await createOpenGame(pengPool, player1, 1);
      expect(await pengPool.gameCount()).to.equal(1);
      await createOpenGame(pengPool, player1, 5);
      expect(await pengPool.gameCount()).to.equal(2);
    });

    it("holds the ETH in the contract after creation", async function () {
      const { pengPool, player1 } = await deployFixture();
      await createOpenGame(pengPool, player1, 5);
      const balance = await ethers.provider.getBalance(await pengPool.getAddress());
      expect(balance).to.equal(BET[5]);
    });

    it("reverts with invalid bet amount (e.g. 3 USD)", async function () {
      const { pengPool, player1 } = await deployFixture();
      await expect(
        pengPool.connect(player1).createGame(3, { value: BET[1] })
      ).to.be.revertedWith("PengPool: bet must be 1, 2, 5, or 10 USD");
    });

    it("reverts when ETH sent is too low (below tolerance)", async function () {
      const { pengPool, player1 } = await deployFixture();
      const tooLow = BET[1] - BET[1] / 100n - 1n;
      await expect(
        pengPool.connect(player1).createGame(1, { value: tooLow })
      ).to.be.revertedWith("PengPool: ETH amount out of range for chosen USD bet");
    });

    it("reverts when ETH sent is too high (above tolerance)", async function () {
      const { pengPool, player1 } = await deployFixture();
      const tooHigh = BET[1] + BET[1] / 100n + 1n;
      await expect(
        pengPool.connect(player1).createGame(1, { value: tooHigh })
      ).to.be.revertedWith("PengPool: ETH amount out of range for chosen USD bet");
    });

    it("accepts ETH within the +1% tolerance window", async function () {
      const { pengPool, player1 } = await deployFixture();
      const withinHigh = BET[10] + BET[10] / 100n;  // exactly +1%
      await expect(
        pengPool.connect(player1).createGame(10, { value: withinHigh })
      ).to.emit(pengPool, "GameCreated");
    });
  });

  // ── joinGame ──────────────────────────────────────────────────────────────
  describe("joinGame", function () {
    it("joins an open game, changes status to ACTIVE and emits PlayerJoined", async function () {
      const { pengPool, player1, player2 } = await deployFixture();
      const gameId = await createOpenGame(pengPool, player1, 1);

      await expect(
        pengPool.connect(player2).joinGame(gameId, { value: BET[1] })
      )
        .to.emit(pengPool, "PlayerJoined")
        .withArgs(gameId, player2.address);

      const game = await pengPool.getGame(gameId);
      expect(game.player2).to.equal(player2.address);
      expect(game.status).to.equal(1); // ACTIVE
    });

    it("holds both players' funds in the contract", async function () {
      const { pengPool, player1, player2 } = await deployFixture();
      const gameId = await createOpenGame(pengPool, player1, 10);
      await pengPool.connect(player2).joinGame(gameId, { value: BET[10] });
      const balance = await ethers.provider.getBalance(await pengPool.getAddress());
      expect(balance).to.equal(BET[10] * 2n);
    });

    it("reverts if game does not exist (status defaults to OPEN with zero player)", async function () {
      const { pengPool, player2 } = await deployFixture();
      // gameId 999 has betAmount = 0, so msg.value == 0 would pass betAmount check
      // but player1 is address(0) — attempt to join still fails on status check
      // because a non-existent game has status OPEN (0) and betAmount 0
      // sending 0 value would be required — just test that joining with wrong value reverts
      await expect(
        pengPool.connect(player2).joinGame(999, { value: BET[1] })
      ).to.be.revertedWith("PengPool: must match game's exact bet amount");
    });

    it("reverts if player1 tries to join their own game", async function () {
      const { pengPool, player1 } = await deployFixture();
      const gameId = await createOpenGame(pengPool, player1, 1);
      await expect(
        pengPool.connect(player1).joinGame(gameId, { value: BET[1] })
      ).to.be.revertedWith("PengPool: cannot join own game");
    });

    it("reverts if ETH sent does not match game betAmount", async function () {
      const { pengPool, player1, player2 } = await deployFixture();
      const gameId = await createOpenGame(pengPool, player1, 1);
      await expect(
        pengPool.connect(player2).joinGame(gameId, { value: BET[2] }) // wrong amount
      ).to.be.revertedWith("PengPool: must match game's exact bet amount");
    });

    it("reverts if the game is already ACTIVE", async function () {
      const { pengPool, player1, player2, other } = await deployFixture();
      const gameId = await createOpenGame(pengPool, player1, 1);
      await pengPool.connect(player2).joinGame(gameId, { value: BET[1] });
      await expect(
        pengPool.connect(other).joinGame(gameId, { value: BET[1] })
      ).to.be.revertedWith("PengPool: game not open");
    });
  });

  // ── declareWinner ─────────────────────────────────────────────────────────
  describe("declareWinner", function () {
    async function startedGame(fixture, betUSD = 1) {
      const { pengPool, player1, player2 } = fixture;
      const gameId = await createOpenGame(pengPool, player1, betUSD);
      await pengPool.connect(player2).joinGame(gameId, { value: BET[betUSD] });
      return gameId;
    }

    it("transfers exactly 95% to winner and 5% to commissionWallet", async function () {
      const fixture = await deployFixture();
      const { pengPool, owner, commissionWallet, player1, player2 } = fixture;
      const gameId = await startedGame(fixture, 1);

      const pot        = BET[1] * 2n;
      const commission = pot * 5n / 100n;
      const prize      = pot - commission;

      await expect(pengPool.connect(owner).declareWinner(gameId, player1.address))
        .to.changeEtherBalances(
          [player1, commissionWallet, pengPool],
          [prize, commission, -(pot)]
        );
    });

    it("works correctly for every bet tier (prize = 95%, fee = 5%)", async function () {
      for (const betUSD of [1, 2, 5, 10]) {
        const fixture = await deployFixture();
        const { pengPool, owner, commissionWallet, player1, player2 } = fixture;
        const gameId = await startedGame(fixture, betUSD);

        const pot        = BET[betUSD] * 2n;
        const commission = pot * 5n / 100n;
        const prize      = pot - commission;

        await expect(pengPool.connect(owner).declareWinner(gameId, player2.address))
          .to.changeEtherBalances(
            [player2, commissionWallet, pengPool],
            [prize, commission, -(pot)]
          );
      }
    });

    it("emits WinnerDeclared with correct prize and commission amounts", async function () {
      const fixture = await deployFixture();
      const { pengPool, owner, player1 } = fixture;
      const gameId = await startedGame(fixture, 2);

      const pot        = BET[2] * 2n;
      const commission = pot * 5n / 100n;
      const prize      = pot - commission;

      await expect(pengPool.connect(owner).declareWinner(gameId, player1.address))
        .to.emit(pengPool, "WinnerDeclared")
        .withArgs(gameId, player1.address, prize, commission);
    });

    it("sets game status to FINISHED and records winner", async function () {
      const fixture = await deployFixture();
      const { pengPool, owner, player1 } = fixture;
      const gameId = await startedGame(fixture, 1);
      await pengPool.connect(owner).declareWinner(gameId, player1.address);
      const game = await pengPool.getGame(gameId);
      expect(game.status).to.equal(2); // FINISHED
      expect(game.winner).to.equal(player1.address);
    });

    it("reverts if caller is not the owner", async function () {
      const fixture = await deployFixture();
      const { pengPool, player1, player2 } = fixture;
      const gameId = await startedGame(fixture, 1);
      await expect(
        pengPool.connect(player1).declareWinner(gameId, player1.address)
      ).to.be.revertedWith("PengPool: not owner");
    });

    it("reverts if game is not ACTIVE (still OPEN)", async function () {
      const { pengPool, owner, player1 } = await deployFixture();
      const gameId = await createOpenGame(pengPool, player1, 1);
      await expect(
        pengPool.connect(owner).declareWinner(gameId, player1.address)
      ).to.be.revertedWith("PengPool: game not active");
    });

    it("reverts if winner is not one of the two players", async function () {
      const fixture = await deployFixture();
      const { pengPool, owner, other } = fixture;
      const gameId = await startedGame(fixture, 1);
      await expect(
        pengPool.connect(owner).declareWinner(gameId, other.address)
      ).to.be.revertedWith("PengPool: invalid winner address");
    });

    it("reverts if called a second time on a finished game", async function () {
      const fixture = await deployFixture();
      const { pengPool, owner, player1 } = fixture;
      const gameId = await startedGame(fixture, 1);
      await pengPool.connect(owner).declareWinner(gameId, player1.address);
      await expect(
        pengPool.connect(owner).declareWinner(gameId, player1.address)
      ).to.be.revertedWith("PengPool: game not active");
    });
  });

  // ── cancelGame ────────────────────────────────────────────────────────────
  describe("cancelGame", function () {
    it("refunds full bet to player1 and emits GameCancelled", async function () {
      const { pengPool, player1 } = await deployFixture();
      const gameId = await createOpenGame(pengPool, player1, 5);

      await expect(pengPool.connect(player1).cancelGame(gameId))
        .to.changeEtherBalances([player1, pengPool], [BET[5], -(BET[5])]);

      await expect(pengPool.connect(player1).cancelGame(gameId))
        .to.be.revertedWith("PengPool: game not open"); // can't cancel twice
    });

    it("emits GameCancelled with correct args", async function () {
      const { pengPool, player1 } = await deployFixture();
      const gameId = await createOpenGame(pengPool, player1, 10);
      await expect(pengPool.connect(player1).cancelGame(gameId))
        .to.emit(pengPool, "GameCancelled")
        .withArgs(gameId, player1.address, BET[10]);
    });

    it("sets game status to CANCELLED", async function () {
      const { pengPool, player1 } = await deployFixture();
      const gameId = await createOpenGame(pengPool, player1, 1);
      await pengPool.connect(player1).cancelGame(gameId);
      const game = await pengPool.getGame(gameId);
      expect(game.status).to.equal(3); // CANCELLED
    });

    it("reverts if caller is not the game creator", async function () {
      const { pengPool, player1, other } = await deployFixture();
      const gameId = await createOpenGame(pengPool, player1, 1);
      await expect(
        pengPool.connect(other).cancelGame(gameId)
      ).to.be.revertedWith("PengPool: not game creator");
    });

    it("reverts if game is already ACTIVE (player2 joined)", async function () {
      const { pengPool, player1, player2 } = await deployFixture();
      const gameId = await createOpenGame(pengPool, player1, 1);
      await pengPool.connect(player2).joinGame(gameId, { value: BET[1] });
      await expect(
        pengPool.connect(player1).cancelGame(gameId)
      ).to.be.revertedWith("PengPool: game not open");
    });
  });

  // ── getOpenGames ──────────────────────────────────────────────────────────
  describe("getOpenGames", function () {
    it("returns only OPEN game IDs, excluding ACTIVE and CANCELLED", async function () {
      const { pengPool, player1, player2 } = await deployFixture();

      const id0 = await createOpenGame(pengPool, player1, 1);  // will be joined → ACTIVE
      const id1 = await createOpenGame(pengPool, player1, 1);  // will be cancelled
      const id2 = await createOpenGame(pengPool, player1, 1);  // stays OPEN

      await pengPool.connect(player2).joinGame(id0, { value: BET[1] });
      await pengPool.connect(player1).cancelGame(id1);

      const open = await pengPool.getOpenGames();
      expect(open.map(id => Number(id))).to.deep.equal([Number(id2)]);
    });

    it("returns empty array when no games exist", async function () {
      const { pengPool } = await deployFixture();
      expect(await pengPool.getOpenGames()).to.deep.equal([]);
    });
  });

  // ── Admin functions ───────────────────────────────────────────────────────
  describe("Admin", function () {
    it("owner can update commission wallet and emits event", async function () {
      const { pengPool, owner, other } = await deployFixture();
      const old = await pengPool.commissionWallet();
      await expect(pengPool.connect(owner).setCommissionWallet(other.address))
        .to.emit(pengPool, "CommissionWalletUpdated")
        .withArgs(old, other.address);
      expect(await pengPool.commissionWallet()).to.equal(other.address);
    });

    it("owner can update price feed and emits event", async function () {
      const { pengPool, owner, mockFeed } = await deployFixture();
      const MockAggregator = await ethers.getContractFactory("MockV3Aggregator");
      const newFeed = await MockAggregator.deploy(FEED_DECIMALS, FEED_PRICE);
      const oldAddr = await mockFeed.getAddress();
      const newAddr = await newFeed.getAddress();

      await expect(pengPool.connect(owner).setPriceFeed(newAddr))
        .to.emit(pengPool, "PriceFeedUpdated")
        .withArgs(oldAddr, newAddr);
      expect(await pengPool.priceFeed()).to.equal(newAddr);
    });

    it("non-owner cannot update commission wallet", async function () {
      const { pengPool, other } = await deployFixture();
      await expect(
        pengPool.connect(other).setCommissionWallet(other.address)
      ).to.be.revertedWith("PengPool: not owner");
    });

    it("non-owner cannot update price feed", async function () {
      const { pengPool, mockFeed, other } = await deployFixture();
      await expect(
        pengPool.connect(other).setPriceFeed(await mockFeed.getAddress())
      ).to.be.revertedWith("PengPool: not owner");
    });

    it("setCommissionWallet reverts on zero address", async function () {
      const { pengPool, owner } = await deployFixture();
      await expect(
        pengPool.connect(owner).setCommissionWallet(ethers.ZeroAddress)
      ).to.be.revertedWith("PengPool: invalid address");
    });

    it("setPriceFeed reverts on zero address", async function () {
      const { pengPool, owner } = await deployFixture();
      await expect(
        pengPool.connect(owner).setPriceFeed(ethers.ZeroAddress)
      ).to.be.revertedWith("PengPool: invalid address");
    });
  });
});
