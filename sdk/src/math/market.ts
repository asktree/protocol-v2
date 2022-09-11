import { BN } from '@project-serum/anchor';
import {
	MarketAccount,
	PositionDirection,
	MarginCategory,
	BankAccount,
	BankBalanceType,
} from '../types';
import {
	calculateAmmReservesAfterSwap,
	calculatePrice,
	calculateUpdatedAMMSpreadReserves,
	getSwapDirection,
	calculateUpdatedAMM,
} from './amm';
import {
	calculateSizeDiscountAssetWeight,
	calculateSizePremiumLiabilityWeight,
} from './margin';
import { OraclePriceData } from '../oracles/types';
import {
	BASE_PRECISION,
	MARGIN_PRECISION,
	PRICE_TO_QUOTE_PRECISION,
} from '../constants/numericConstants';
import { getTokenAmount } from './bankBalance';

/**
 * Calculates market mark price
 *
 * @param market
 * @return markPrice : Precision MARK_PRICE_PRECISION
 */
export function calculateMarkPrice(
	market: MarketAccount,
	oraclePriceData: OraclePriceData
): BN {
	const newAmm = calculateUpdatedAMM(market.amm, oraclePriceData);
	return calculatePrice(
		newAmm.baseAssetReserve,
		newAmm.quoteAssetReserve,
		newAmm.pegMultiplier
	);
}

/**
 * Calculates market bid price
 *
 * @param market
 * @return bidPrice : Precision MARK_PRICE_PRECISION
 */
export function calculateBidPrice(
	market: MarketAccount,
	oraclePriceData: OraclePriceData
): BN {
	const { baseAssetReserve, quoteAssetReserve, newPeg } =
		calculateUpdatedAMMSpreadReserves(
			market.amm,
			PositionDirection.SHORT,
			oraclePriceData
		);

	return calculatePrice(baseAssetReserve, quoteAssetReserve, newPeg);
}

/**
 * Calculates market ask price
 *
 * @param market
 * @return bidPrice : Precision MARK_PRICE_PRECISION
 */
export function calculateAskPrice(
	market: MarketAccount,
	oraclePriceData: OraclePriceData
): BN {
	const { baseAssetReserve, quoteAssetReserve, newPeg } =
		calculateUpdatedAMMSpreadReserves(
			market.amm,
			PositionDirection.LONG,
			oraclePriceData
		);

	return calculatePrice(baseAssetReserve, quoteAssetReserve, newPeg);
}

export function calculateNewMarketAfterTrade(
	baseAssetAmount: BN,
	direction: PositionDirection,
	market: MarketAccount
): MarketAccount {
	const [newQuoteAssetReserve, newBaseAssetReserve] =
		calculateAmmReservesAfterSwap(
			market.amm,
			'base',
			baseAssetAmount.abs(),
			getSwapDirection('base', direction)
		);

	const newAmm = Object.assign({}, market.amm);
	const newMarket = Object.assign({}, market);
	newMarket.amm = newAmm;
	newMarket.amm.quoteAssetReserve = newQuoteAssetReserve;
	newMarket.amm.baseAssetReserve = newBaseAssetReserve;

	return newMarket;
}

export function calculateMarkOracleSpread(
	market: MarketAccount,
	oraclePriceData: OraclePriceData
): BN {
	const markPrice = calculateMarkPrice(market, oraclePriceData);
	return calculateOracleSpread(markPrice, oraclePriceData);
}

export function calculateOracleSpread(
	price: BN,
	oraclePriceData: OraclePriceData
): BN {
	return price.sub(oraclePriceData.price);
}

export function calculateMarketMarginRatio(
	market: MarketAccount,
	size: BN,
	marginCategory: MarginCategory
): number {
	let marginRatio;
	switch (marginCategory) {
		case 'Initial':
			marginRatio = calculateSizePremiumLiabilityWeight(
				size,
				market.imfFactor,
				new BN(market.marginRatioInitial),
				MARGIN_PRECISION
			).toNumber();
			break;
		case 'Maintenance':
			marginRatio = market.marginRatioMaintenance;
			break;
	}

	return marginRatio;
}

export function calculateUnrealizedAssetWeight(
	market: MarketAccount,
	unrealizedPnl: BN,
	marginCategory: MarginCategory
): BN {
	let assetWeight: BN;

	switch (marginCategory) {
		case 'Initial':
			assetWeight = calculateSizeDiscountAssetWeight(
				unrealizedPnl,
				market.unrealizedImfFactor,
				new BN(market.unrealizedInitialAssetWeight)
			);
			break;
		case 'Maintenance':
			assetWeight = new BN(market.unrealizedMaintenanceAssetWeight);
			break;
	}

	return assetWeight;
}

export function calculateMarketAvailablePNL(
	market: MarketAccount,
	bank: BankAccount
): BN {
	return getTokenAmount(market.pnlPool.balance, bank, BankBalanceType.DEPOSIT);
}

export function calculateNetUserImbalance(
	market: MarketAccount,
	bank: BankAccount,
	oraclePriceData: OraclePriceData
): BN {
	const netUserPositionValue = market.amm.netBaseAssetAmount
		.mul(oraclePriceData.price)
		.div(BASE_PRECISION)
		.div(PRICE_TO_QUOTE_PRECISION);

	const netUserCostBasis = market.amm.quoteAssetAmountLong
		.add(market.amm.quoteAssetAmountShort)
		.sub(market.amm.cumulativeSocialLoss);

	const userEntitledPnl = netUserPositionValue.add(netUserCostBasis);

	const pnlPool = getTokenAmount(
		market.pnlPool.balance,
		bank,
		BankBalanceType.DEPOSIT
	);

	const imbalance = userEntitledPnl.sub(pnlPool);

	return imbalance;
}
