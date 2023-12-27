import { PriorityFeeStrategy } from './types';
import { assertSamplesDescending } from './utils';

export class MaxOverSlotsStrategy implements PriorityFeeStrategy {
	constructor() {}

	calculate(samples: { slot: number; prioritizationFee: number }[]): number {
		
		assertSamplesDescending(samples);

		if (samples.length === 0) {
			return 0;
		}
		// Assuming samples are sorted in descending order of slot.
		let currMaxFee = samples[0].prioritizationFee;

		for (let i = 0; i < samples.length; i++) {
			currMaxFee = Math.max(samples[i].prioritizationFee, currMaxFee);

		}
		return currMaxFee;
	}
}
