const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Lock", function () {
  async function deployLockFixture() {
    const ONE_MINUTE = 60;
    const lockedAmount = ethers.parseEther("0.001");
    const unlockTime = (await time.latest()) + ONE_MINUTE;

    const [owner, otherAccount] = await ethers.getSigners();
    const Lock = await ethers.getContractFactory("Lock");
    const lock = await Lock.deploy(unlockTime, { value: lockedAmount });

    return { lock, unlockTime, lockedAmount, owner, otherAccount };
  }

  it("Should set the right unlockTime", async function () {
    const { lock, unlockTime } = await deployLockFixture();
    expect(await lock.unlockTime()).to.equal(unlockTime);
  });

  it("Should revert if called too soon", async function () {
    const { lock } = await deployLockFixture();
    await expect(lock.withdraw()).to.be.revertedWith("You can't withdraw yet");
  });

  it("Should transfer funds after unlock", async function () {
    const { lock, unlockTime, lockedAmount, owner } = await deployLockFixture();
    await time.increaseTo(unlockTime);
    await expect(lock.withdraw()).to.changeEtherBalances(
      [owner, lock],
      [lockedAmount, -lockedAmount]
    );
  });
});
