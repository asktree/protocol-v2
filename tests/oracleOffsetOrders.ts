import * as anchor from '@project-serum/anchor';

import { Program } from '@project-serum/anchor';

import { Keypair } from '@solana/web3.js';

import { assert } from 'chai';

import {
	Admin,
	BN,
	PRICE_PRECISION,
	ClearingHouse,
	PositionDirection,
	ClearingHouseUser,
	Wallet,
	getLimitOrderParams,
	MarketStatus,
	AMM_RESERVE_PRECISION,
	calculateEntryPrice,
	OracleSource,
	ZERO,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
	initializeQuoteSpotMarket,
} from './testHelpers';

describe('oracle offset', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let fillerClearingHouse: Admin;
	let fillerClearingHouseUser: ClearingHouseUser;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(100000);
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 9).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 9).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	const marketIndex = 0;
	let solUsd;

	let marketIndexes;
	let spotMarketIndexes;
	let oracleInfos;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(1);
		marketIndexes = [0];
		spotMarketIndexes = [0];
		oracleInfos = [{ publicKey: solUsd, source: OracleSource.PYTH }];

		fillerClearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await fillerClearingHouse.initialize(usdcMint.publicKey, true);
		await fillerClearingHouse.subscribe();
		await initializeQuoteSpotMarket(fillerClearingHouse, usdcMint.publicKey);
		await fillerClearingHouse.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(60 * 60); // 1 HOUR

		await fillerClearingHouse.initializePerpMarket(
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);
		await fillerClearingHouse.updatePerpMarketStatus(0, MarketStatus.ACTIVE);

		await fillerClearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		fillerClearingHouseUser = new ClearingHouseUser({
			clearingHouse: fillerClearingHouse,
			userAccountPublicKey: await fillerClearingHouse.getUserAccountPublicKey(),
		});
		await fillerClearingHouseUser.subscribe();
	});

	beforeEach(async () => {
		await fillerClearingHouse.moveAmmPrice(
			0,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve
		);
		await setFeedPrice(anchor.workspace.Pyth, 1, solUsd);
	});

	after(async () => {
		await fillerClearingHouse.unsubscribe();
		await fillerClearingHouseUser.unsubscribe();
	});

	it('long taker', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const clearingHouse = new ClearingHouse({
			connection,
			wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const clearingHouseUser = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await clearingHouseUser.subscribe();

		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = ZERO;
		const reduceOnly = false;
		const priceOffset = PRICE_PRECISION.div(new BN(20)).neg();

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			reduceOnly,
			userOrderId: 1,
			oraclePriceOffset: priceOffset.toNumber(),
		});
		await clearingHouse.placePerpOrder(orderParams);

		await fillerClearingHouse.moveAmmPrice(
			marketIndex,
			ammInitialBaseAssetReserve.mul(new BN(11)).div(new BN(10)),
			ammInitialQuoteAssetReserve
		);

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		await fillerClearingHouse.fillPerpOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			order
		);

		await clearingHouseUser.fetchAccounts();
		const position = clearingHouseUser.getUserPosition(marketIndex);
		const entryPrice = calculateEntryPrice(position);
		assert(entryPrice.eq(new BN(909093)));

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});

	it('long maker', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const clearingHouse = new ClearingHouse({
			connection,
			wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const clearingHouseUser = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await clearingHouseUser.subscribe();

		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const reduceOnly = false;
		const priceOffset = PRICE_PRECISION.div(new BN(20)).neg();
		const price = ZERO; // oracle offsetoor

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			price,
			baseAssetAmount,
			reduceOnly,
			userOrderId: 1,
			postOnly: true,
			oraclePriceOffset: priceOffset.toNumber(),
		});

		await clearingHouse.placePerpOrder(orderParams);

		await fillerClearingHouse.moveAmmPrice(
			marketIndex,
			ammInitialBaseAssetReserve.mul(new BN(11)).div(new BN(10)),
			ammInitialQuoteAssetReserve
		);

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		await fillerClearingHouse.fillPerpOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouseUser.fetchAccounts();
		const position = clearingHouseUser.getUserPosition(marketIndex);
		const entryPrice = calculateEntryPrice(position);
		const expectedEntryPrice = new BN(950000);
		console.log(entryPrice.toString(), 'vs', expectedEntryPrice.toString());
		assert(entryPrice.eq(expectedEntryPrice));

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});

	it('short taker', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const clearingHouse = new ClearingHouse({
			connection,
			wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const clearingHouseUser = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await clearingHouseUser.subscribe();

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const reduceOnly = false;
		const priceOffset = PRICE_PRECISION.div(new BN(20));
		const price = ZERO; // oracle offsetoor

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			price,
			baseAssetAmount,
			reduceOnly,
			userOrderId: 1,
			oraclePriceOffset: priceOffset.toNumber(),
		});
		await clearingHouse.placePerpOrder(orderParams);

		await fillerClearingHouse.moveAmmPrice(
			marketIndex,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve.mul(new BN(11)).div(new BN(10))
		);

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		await fillerClearingHouse.fillPerpOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouseUser.fetchAccounts();
		const position = clearingHouseUser.getUserPosition(marketIndex);
		const entryPrice = calculateEntryPrice(position);
		assert(entryPrice.eq(new BN(1099997)));

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});

	it('short maker', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const clearingHouse = new ClearingHouse({
			connection,
			wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const clearingHouseUser = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await clearingHouseUser.subscribe();

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const reduceOnly = false;
		const priceOffset = PRICE_PRECISION.div(new BN(20));
		const price = ZERO;

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			reduceOnly,
			price,
			userOrderId: 1,
			postOnly: true,
			oraclePriceOffset: priceOffset.toNumber(),
		});
		await clearingHouse.placePerpOrder(orderParams);

		await fillerClearingHouse.moveAmmPrice(
			marketIndex,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve.mul(new BN(11)).div(new BN(10))
		);

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getOrderByUserOrderId(1);

		await fillerClearingHouse.fillPerpOrder(
			await clearingHouseUser.getUserAccountPublicKey(),
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouseUser.fetchAccounts();
		const position = clearingHouseUser.getUserPosition(marketIndex);
		const entryPrice = calculateEntryPrice(position);
		const expectedEntryPrice = PRICE_PRECISION.add(priceOffset);
		console.log(entryPrice.toString());
		assert(entryPrice.eq(expectedEntryPrice));

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});

	it('cancel by order id', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const clearingHouse = new ClearingHouse({
			connection,
			wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const clearingHouseUser = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await clearingHouseUser.subscribe();

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const reduceOnly = false;
		const priceOffset = PRICE_PRECISION.div(new BN(20));
		const price = ZERO;

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			reduceOnly,
			postOnly: true,
			oraclePriceOffset: priceOffset.toNumber(),
		});
		await clearingHouse.placePerpOrder(orderParams);

		await clearingHouseUser.fetchAccounts();
		const orderId = clearingHouseUser.getUserAccount().orders[0].orderId;
		await clearingHouse.cancelOrder(orderId);

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});

	it('cancel by user order id', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const clearingHouse = new ClearingHouse({
			connection,
			wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: spotMarketIndexes,
			oracleInfos,
		});
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);
		const clearingHouseUser = new ClearingHouseUser({
			clearingHouse,
			userAccountPublicKey: await clearingHouse.getUserAccountPublicKey(),
		});
		await clearingHouseUser.subscribe();

		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const reduceOnly = false;
		const priceOffset = PRICE_PRECISION.div(new BN(20));
		const price = ZERO;

		const orderParams = getLimitOrderParams({
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			reduceOnly,
			postOnly: true,
			userOrderId: 1,
			oraclePriceOffset: priceOffset.toNumber(),
		});
		await clearingHouse.placePerpOrder(orderParams);

		await clearingHouseUser.fetchAccounts();
		await clearingHouse.cancelOrderByUserId(1);

		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
	});
});
