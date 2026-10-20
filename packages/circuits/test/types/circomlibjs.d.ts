declare module "circomlibjs" {
  export function buildPoseidon(): Promise<PoseidonFn>;

  interface PoseidonFn {
    (inputs: bigint[]): Uint8Array;
    F: {
      toObject(value: Uint8Array): bigint;
    };
  }
}
