import { BadRequestException } from "@nestjs/common";
import { Chains } from "./types";

type ConfigArrayFor<T extends keyof Chains> = NonNullable<Chains[T]>;
type ConfigFor<T extends keyof Chains> = ConfigArrayFor<T>[number];

// Genuinely chain-generic array/id lookup — works for any key `zChains` (config/schemas.ts)
// defines, returning the raw parsed config rather than a chain-specific wrapper. Each chain's
// own ConfigService (EvmConfigService, StellarConfigService, ...) wraps the raw config itself
// (e.g. `new EvmChainConfigWrapper(relayerConfig.chain(ChainType.EVM).config(chainId))`) —
// this class has no chain-specific knowledge at all.
export class Chain<T extends keyof Chains> {
    private readonly configs: ConfigArrayFor<T>;

    constructor(
        private readonly chainType: T,
        configs?: Chains[T]
    ) {
        this.configs = (configs ?? []) as ConfigArrayFor<T>;
    }

    config(chainId: number): ConfigFor<T> {
        const found = this.configs.find((c) => c.id === chainId);

        if (found !== undefined) {
            return found;
        } else {
            //TODO errors
            throw new BadRequestException(`Config for chainId ${chainId} not found on chain ${this.chainType}`);
        }
    }

    allConfigs(): ConfigFor<T>[] {
        return [...this.configs];
    }

    exists(): boolean {
        return this.configs.length > 0;
    }
}
