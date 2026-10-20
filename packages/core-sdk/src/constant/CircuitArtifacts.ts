import type { CircuitManifest } from "../internal.js";

/**
 * SDK-shipped default IPFS gateway used by `PoolSessionBuilder` when neither
 * `circuitArtifactsDir` nor `circuitGatewayUrls` is supplied.
 *
 * **Starter value, not a production guarantee.** Public IPFS gateway behavior
 * varies across hosts (CORS quirks under redirect chains, HTML-viewer wrappers
 * for directory CIDs, aggressive rate limits). Production deployments should
 * supply `circuitGatewayUrls` with their own list — typically a dedicated
 * Pinata/Filebase/4everland gateway with an API key plus one or more public
 * fallbacks tuned for the deployment's geography and traffic profile.
 *
 * Single host today (`ipfs.io`) — Protocol Labs canonical, raw-bytes semantics
 * for raw file CIDs, CORS-permissive. Adding more public hosts as defaults
 * has proven unreliable (Pinata wraps directory CIDs in HTML; dweb.link/
 * 4everland have shown intermittent browser CORS failures).
 *
 * Not exported from `external.ts` — internal SDK opinion.
 */
export const DEFAULT_IPFS_GATEWAY_URLS: readonly string[] = Object.freeze(["https://ipfs.io/ipfs"]);

/**
 * Allowlist pattern for circuit names. Every known circuit (`deposit`,
 * `ragequit`, `transact_NxM`) is lowercase alphanumerics + underscore. Used by
 * `LocalCircuitArtifacts` to reject path-traversal sequences before
 * interpolating the name into a filesystem path — `.`, `/`, `\`, and null
 * bytes are all outside this set, so `..` cannot be constructed.
 */
export const CIRCUIT_NAME_PATTERN = /^[a-z0-9_]+$/;

/**
 * Default circuit manifest shipped with the SDK: 27 entries (deposit, ragequit,
 * and transact_NxM for N,M in [1,5]).
 *
 * CIDs come from the pinned bundle `circuit-artifacts-ceremony` (root directory
 * CID `QmWPCQmvkJMtFEyQ94MU2CFniH6u1sbq1AQYDjj4HFpWDX`): the trusted-setup ceremony
 * keys (see packages/circuits/CEREMONY.md). Each circuit dir holds
 * `<name>_js/<name>.wasm`, `groth16_pkey.zkey`, and `groth16_vkey.json`; the
 * manifest references the file-level CIDs so gateways serve raw bytes directly.
 *
 * The CIDs are dag-pb (folder pin), so they cannot verify file content by
 * themselves — the `*Sha256` digests are the integrity anchor instead (see
 * `IpfsCircuitArtifacts.verifyArtifactContent`).
 *
 * Do not edit these values by hand. Regenerate with
 * `pnpm generate:circuit-manifest` (scripts/generate-circuit-manifest.mjs),
 * which downloads every artifact and derives the CID and sha256 digest from
 * the same response — CIDs and digests collected from different sources is
 * how a manifest ends up with digests that match no real file.
 */
export const DEFAULT_CIRCUIT_MANIFEST: CircuitManifest = {
    deposit: {
        wasm: "QmbFwUiZywpkCd9AYr3xiVJN2K99ma7raz5FvAS8A8j8DD",
        wasmSha256: "833e7b3c44a900a95496009a36284e11f57ba0385fab6b63f92075750817550a",
        provingKey: "QmRmMxXerqWixoVcsGzW8ighGLWv65ZMHVeuwYFURaHT78",
        provingKeySha256: "e6fb5283c7b7511b0422a773d9f054925969e47e8ddf55a6b38b590c951a73a4",
        verificationKey: "QmexBLo5WKqq7KZAkGKHwjpFANYU74GBniPcjtShuc2nAp",
        verificationKeySha256: "923f71ca381d6f8ee07c18807f738c4b2617494388efc4b1f914c3253f01da86",
    },
    ragequit: {
        wasm: "QmfJSLSutPLJgRbtmothHAn3jFpKmXUwFnAdjecCEmJFQz",
        wasmSha256: "95108046f922d9cb08a1d4e42c88708af03233551a5e13a7118d7a6eff5d31c4",
        provingKey: "QmS2Xus45NU3opv29DphTkNzEavqQpVjtTNJxcXXm41zyW",
        provingKeySha256: "044abe871b1b79fecb6b4ca6128d08a142d7ce8665f439032953bae92f6ab076",
        verificationKey: "QmYVyUcHm4YDKNPF8Lxa3JXvaFup9ktqdLRPvCqUmtEmaP",
        verificationKeySha256: "ea987f112952f0eda4acd5cfe76ea6a3e8114467b1159207b1aedd8b1c631913",
    },
    transact_1x1: {
        wasm: "QmYLFBpsJzeKXDfxcKdwz4rrhZTDoWiYyHNkDyreFrFrau",
        wasmSha256: "bd13ab4130320f095cdee83b42e27877fc6c17f18be3fbdfc55436d33689d262",
        provingKey: "QmVhz51m6PnfCAo4mi9ufbh9Vp9hx8UZhjbQ8eDrxVg5m4",
        provingKeySha256: "e92ad88f417c034f073580658839b64fdd1ad3c89a86a9faa926728f80351121",
        verificationKey: "QmR8E16n7fcfuGoi7JKdiX1kg2GB65Dy4fgwkybqFJJ7QV",
        verificationKeySha256: "6541ab63bd3859452637989aabfc62949b94952bcdc9dd70ef1d38a4e838c155",
    },
    transact_1x2: {
        wasm: "QmYmzdZR25VGfXnfsKY3tjm4ymjbCt67pgnhdqDBDwvxPR",
        wasmSha256: "71ffcdc53e5808c89ebf735ef45d0ffabfce9e6f640d565adc4f02e36ad1a72e",
        provingKey: "QmTQbU7YjFsTm1CjJdWDnYWAbJM7iTAoXf8t1Fc7nMxfyz",
        provingKeySha256: "996b738388d50b8e85fa1c84b0733ac70ad3c2f320e226037d91ad8c8bf1335f",
        verificationKey: "QmTKP8kLbyM1go6AWZpsdJRpVry9mKKYcqG4c7XMG6DvzV",
        verificationKeySha256: "9d272d508ac04695a99cd89fa93e5fcc979fb8ad9a8db919ea28afd3de7e277e",
    },
    transact_1x3: {
        wasm: "QmWQb92RQwmycPnfF1zGREU5Ss6N1wEx1e3nm47vioNcqB",
        wasmSha256: "730ae4756ba37489137ac82e117e1169f6cc8137a17f4733c779dddc69de1158",
        provingKey: "QmW2YpyqeKXbkqCVyS8f3wAeshnqKxq1XxPJHdrksCGAdL",
        provingKeySha256: "6e6e697f672a35770d2d9f49588bc841b943ff7c10a6afed07b6627d5f62fd3f",
        verificationKey: "QmVeuBvkJiF2AwRGhLyrpCKpSjWvfDzkyxei6cLwCUneC1",
        verificationKeySha256: "f755f07f5e281e04bb16214b7ad0a8ddb8cf4fb0bf18093ad97962bdab38614e",
    },
    transact_1x4: {
        wasm: "QmS3DpwFrttLtbHzW995ifAgeXiuL2QHzABE9v8DZ7FG1v",
        wasmSha256: "9da4a23f8fdf1bd22db6f2a06ee3b26d6058451eecf0fba99707df14bd7d5d4f",
        provingKey: "Qmc5fQTHPxVAwVgsSHiuh25kXwJk285zfYfACCd2T7B4EQ",
        provingKeySha256: "5ddee0a56c6ffc09c3f1f4ac4be78fe54b5c2b626a922eaec14e848558f91542",
        verificationKey: "QmT4Xw2JNpuSNkM6vQwjp6CP2C7pVMAeYVDDAgmrtc2ray",
        verificationKeySha256: "68aba7cc58d9012d2fb61d6db6c2f31577996e204c334ace0a9893f48697fbdb",
    },
    transact_1x5: {
        wasm: "QmNwpbM9sX62pTLRrZnvBvRmjos57dm6ZGqkVLdXdqQW9v",
        wasmSha256: "d18ce1511bc8a3e80229381e7b3b2f226106fc044579b2460a3bf2d4dcfe415e",
        provingKey: "QmbsGaDybtK7HjpWBsw9oqU6YJT227Jr1RdzBGd3fPLyFY",
        provingKeySha256: "eeb45b1fd355d87a4975341b70982f993215370efec45c8b13bb065c6d9145c1",
        verificationKey: "QmaUtxNuVYYa49AajJiN68mkJCxY9ijnoDWxJJnbnkhc5T",
        verificationKeySha256: "d6cf1310f5de3c90735de976f3fe07f8e22d435043fe68aab80cef822b8f6b09",
    },
    transact_2x1: {
        wasm: "QmUYpWth4Mu9LTziML5sqFpVixkWAYbricd6o5Xid1ksrW",
        wasmSha256: "a1fa16ad0824fe40df716e8bfd0716effad68dcb1ce81f108db596e6a752f15c",
        provingKey: "QmeCef49sMXqzfdExP8QTvRKq53ot2rqtsETHgpDUQ2x9Y",
        provingKeySha256: "3afe537fd4762cb6957f1c8532049879a4f29ed7c54ef893a8299dabf68d9ea5",
        verificationKey: "Qmb7zFqVjfjuSHKUVo4Mm8diJKy8Dk9e4JWkXcuCToVP7h",
        verificationKeySha256: "eac99f1b7cdf1ee7949a6288151278565af02ee14cec10f0f16ed9aa59302781",
    },
    transact_2x2: {
        wasm: "QmZCCa4bMxB4XesiRQ8Nnxz3PHCdqR9wB14NYz1aaoGmGt",
        wasmSha256: "578a1241233edffba81ca58c2fd0af48aa6434bd5a667caf02a5e3393a1b3664",
        provingKey: "QmYCFMhu3quTe6PX18Pq2S8ZAGURRZzGXKDxz4Th38LykM",
        provingKeySha256: "2083cba8cbeba5eb56756331fc01ce1849ebbec7bc64aaeb7a58a7417264f391",
        verificationKey: "QmeDfZrJd6NSmEDHrdwZ5cBu7zeKRAo6XWTd4kDsZC33Nv",
        verificationKeySha256: "71f00aab9752367a94373831c17e8227dd538dfb1bbc3226d5fa0359746a0f32",
    },
    transact_2x3: {
        wasm: "QmcoUX2PMzpjE5DEWhMcnfvAZ9tyJVH7RYMkZC6Sf1cSib",
        wasmSha256: "54b9f706c15eb91ea8b2012c6ebac1eb6b4e1a4ff8ce299d039aaeda57e52ff5",
        provingKey: "QmdUrhriVhDnHdLAUDML4rGsu8TvDaf2Xb8GQzKqK5JLRS",
        provingKeySha256: "b22cc9171ce8c86b00aa95d095c4ed9eb9d5a97df1e2c2d5ee3257b37946b28f",
        verificationKey: "QmYorUejzEgDhugzHjGm92XyKGuvdMPaDyeXnVqgF8yEPk",
        verificationKeySha256: "41fba209a25f2884d7fa998f4657276206cd7ce07cb5cf2ac39a9b690fae4586",
    },
    transact_2x4: {
        wasm: "QmWmTFCKyTNKkZB9FJBUBsysQkpwWzYFpXZrbLu2takMFG",
        wasmSha256: "fe2ae55994b8cca10f27d821ca9551507351cac6960c435e6cca9d643df6a749",
        provingKey: "QmZrPhRd6hVxnVSZDLDzZj8k4NvcmnCZ96RrAr6Nny7G8i",
        provingKeySha256: "b816f6391e06595e714840d66f59a8757541f7eb3160fc92e78275ffad544ccd",
        verificationKey: "Qmbwf2KRB3SoiPXdB8D5omJPfNmy6Bsyy5RhioS63u6Zk9",
        verificationKeySha256: "801a32a20f19315ecc070e56ff0f8c7ea3afecb95ab16efecbfa9e71a86e0301",
    },
    transact_2x5: {
        wasm: "QmQJdT6WVZjGopELtWZKXNSEzSBgNizPjMh9dG4FysN3CJ",
        wasmSha256: "c3e4aab1bc435fd6a4dbbd18c4f26a38efba01412e1f8e675aa2d6ba82fc62ce",
        provingKey: "QmabGqZTmVvGV6entdW1aSBaEbZY2xGr8xr3UqHuLsMB2V",
        provingKeySha256: "259a99de8620a1020680a3eb501b9f2c489cd2a6a0abff0d68967eb76ce937f0",
        verificationKey: "Qmb5Vo4WNYbaPPNgQjue9PB7qvvu56n6ZesHKZTPUnGP8M",
        verificationKeySha256: "593167b2c4eac43b237f6ee9814e7ebe5e02ff91fe9002b3bda84c5e0a0f51e1",
    },
    transact_3x1: {
        wasm: "QmNvWa2CbCwETuCn8nJhGTYuV23X5P6D1HjHKvZsNH6c1c",
        wasmSha256: "eac116e10e378f20d5e21d2bba6cd202e0a74706be3a21582b7681b9d197bc63",
        provingKey: "QmYfmRZdGJN9N9cKNUnGf8a22sQJSXwqNoA1gE2T2gNCSM",
        provingKeySha256: "cb03d64333509767bf1a7cff131e2d790f15afe9dfd74e942398e451d24f754e",
        verificationKey: "QmXP97NKYEbGS7wsfW7RoFoz9tPXhSipAfpqLHai8XBxdF",
        verificationKeySha256: "01d1c8b0bd42e549d3f726a722056e1d3339b992fd52dd1acdf99fe1794fe8c6",
    },
    transact_3x2: {
        wasm: "QmQc3n5zGPHZGq3nCqPd94QChQFam86GcfEj7ojWmH8p1X",
        wasmSha256: "6b195b1419c9ff97e66958d694c0441aa4a9d44afa09bccb43ed1a6a5addcbfa",
        provingKey: "QmcAWBCRPPXWxQvgoSqgCDSJmD7w9sSAXBjmVdTyTheyQS",
        provingKeySha256: "e342328a03523b693462d75e96de5da6ddf8094940007a09ab38ca394540e707",
        verificationKey: "QmWEfP1AgvqnmDcxyXBjtXGxMrkxiv3MHdurwZ5rPY5ccL",
        verificationKeySha256: "068fd751e29d2377b81dab01f0db806162109d5f9a998cbe152140ba8a2a81a0",
    },
    transact_3x3: {
        wasm: "Qmcw59WSBfL3spdia8cyX5QhFJCjW8rPpHPkNQryCSuVhz",
        wasmSha256: "2d4fb8533f62944433ebb58063172ee112580f419291b222037ec7c4e8542552",
        provingKey: "QmSoBcJJ7kKrCgw7NrX8vy7jAQL1nJ3rLzEbwD7CcPx6Tq",
        provingKeySha256: "e1d7ce07915fad1d8d6562ef166a2fce981bdf211827a81f2ba3e029f7b01268",
        verificationKey: "QmXXZjQ6VNTgJXCd3ZqrokVzbtPENkgBGXT7wFiefeUXXH",
        verificationKeySha256: "c221a2f3744780cb1222f5cdbedb753fbf5db07d6409bef87898afb084d8a56c",
    },
    transact_3x4: {
        wasm: "QmboCMo6BrSDWcpAPWnZCW2aj25y4eKRwQbM3h7zf4CZi9",
        wasmSha256: "66e48b0228c1c54ce720b9b2cf8ec0ac0c8ce877fc4806323e58c7b6bfff23fd",
        provingKey: "QmfMMujRmXHG9ikRxSmyzox6nPnMWogZ3FbCCy9tvWzNYF",
        provingKeySha256: "83475261ec0e8125651e3672491d27318cec1db42cadce4cb2db7ab6b907fdc3",
        verificationKey: "Qmai6EEyDKBhkFpdY3LSm4j6i5qZaPDA3jNWzAY1FBYNpW",
        verificationKeySha256: "44be2e4bcd75a58ac3284100230ef6ff847850fa2203141e43b81035539b6e4a",
    },
    transact_3x5: {
        wasm: "QmQZiYCCNEBD7KfHdChDt8ynMEsppi3SiM5ARiZqdca6aM",
        wasmSha256: "6f9dad7ebae38dec783bea9a9bd30059739a9cbce0591a3699d4415f2b723927",
        provingKey: "QmV8AfbDesiyAv3X8Bd5JqE4Z6k5DJhCpHo5cL8eXHgdmV",
        provingKeySha256: "f1816f47842fa384592241e962a46f3938ff8fb931c42b6c5a1021d4ff1481ab",
        verificationKey: "QmPKBJtvSkhBUmYAN8dfQsLniQ9uuPe59JA5MzjwVJiT4D",
        verificationKeySha256: "cfa1576df1f77684f518577db62413be57dd03b3eb37bef2f92a7ded77e5daa2",
    },
    transact_4x1: {
        wasm: "QmPUqbuZfj23dDNH8PEF5kT3Fkr4yrzEhF7vZf6Jt5ryj3",
        wasmSha256: "750789200ed6a56222cf99c80af9ddccaa76081745375a008b0daa7f93345ac1",
        provingKey: "QmZnShNsfCRZU6eUT1hUX7NGm5u7zdcsvaM74BDH1pFb8M",
        provingKeySha256: "6c9a5eaea3f44de8a16de1436839721c3c1a3f92c5746719a6e1d0bf27b7fed8",
        verificationKey: "QmTZVU8RbEXdaEWDQZedCGUFSY6fPCmfgX5d7bunWFsi4B",
        verificationKeySha256: "123bd5234fe613b531e4c2a394f7c88f609139ed029817dec51b3dfef6cc1e0b",
    },
    transact_4x2: {
        wasm: "Qme6URSD5ndGEN7ApHyPzqAk9sh2Xn1DLq67aarVjmTACN",
        wasmSha256: "04aa1d270a361fbc7dc97d67204ec661599a70b9306739ae4b242a2b7e1cf086",
        provingKey: "QmbWh2k1EWzVG4x5gF23BgHJeuH1PG9aE5eZgCAw4FY6ka",
        provingKeySha256: "211675e1dd535fd03e4ae923a13b186c28c2ba60fb1a1b502203979fc863e1cd",
        verificationKey: "QmSfAAH6sbm6dyzEDYBwD7KtAZPRwZQu2it5Sx8er4MMdu",
        verificationKeySha256: "4207b3a6f096525413ddfce137fa0dfc1779af89ddd881fa9d474aea7608345b",
    },
    transact_4x3: {
        wasm: "QmP3QzYZL1sWeZdPz8xSkSTvEhBF9mNZL1qs5jAXM3pjD4",
        wasmSha256: "34e52ec95243118e558985eb6e671f0c03cac2feac517125f7a12eb3c85f5b37",
        provingKey: "QmS35LsYWxYKYdjpU6XeWTddMJ9CJ4cqRm4HizXg13NuDu",
        provingKeySha256: "a9427d68a67b55a9d81c071fea3ffc52bafe4d2eadda0250c20708ab9db405d2",
        verificationKey: "QmZR1m7X2Fctov9WP4du3qT7zVw8NSnjT9i2gF67pjs8pL",
        verificationKeySha256: "fb28caff6c39efbad62e97826314e5653a204661767a722a4f27c7e99e42c014",
    },
    transact_4x4: {
        wasm: "QmSQzARopjufLCiJJm7UwoQesBykfAPp3hgggoNexvT9Xj",
        wasmSha256: "9d300515c9d1eb894ba14de0d336602c5abfcf8dc3aba058fb80e94be63e8278",
        provingKey: "QmXwKSLhhWSXb6VrSth5UmUeU6oqQzVJ7gyz1BQemCT5X6",
        provingKeySha256: "3a8cdb10ede535c64303b198e2db9a4c8c9c5a49bb340c487a220dd64ee47c95",
        verificationKey: "QmYcQ1XH72Fyw3cMKnmPwGFG2XjpGa6VCHrvYZ1WqEEsaV",
        verificationKeySha256: "aafac3ff67eedcc985193ad7521a0ab3b7f414a4d44784d6e18ae5043a6baf8a",
    },
    transact_4x5: {
        wasm: "QmdvSCBYp8KmQn1fXoXVCoSNnRK48YW3tPugwbu4cmqtst",
        wasmSha256: "6b0fa46c5281c542cdd03967a61e35be33b5b26368d1e0c0758c8e760a4f336d",
        provingKey: "QmZD8eJfD7b8V6GcJWmefN5yth2GVRnApqZaAHBmNPkS84",
        provingKeySha256: "239041de4d4d28356afd61cffbd2b2e8909c7e843b923aed8d79c7364bda5345",
        verificationKey: "QmebjYE62JuhYEfN4WEEcam7ekAgSDxZtcLbSs7DFhSZFP",
        verificationKeySha256: "39fe66bc2f4b593edab1d48adca7631fcda12649616c4d3eea416791f679a4a9",
    },
    transact_5x1: {
        wasm: "QmSLhAjbPvZnmsKw6rdFKLkxSRRybQ7qC9ad4tJc71sCZD",
        wasmSha256: "97bcc3a093377fb05284c1fa4f4bf767cd31ff65b37a9939e3bf11490c2f3ea5",
        provingKey: "QmPoKAtWh7y3krE8J2xW1yNyzM37qnbiJdTa6Bxuc4PgJg",
        provingKeySha256: "895add3547d0d33eaae16287148a1596fc9ca6d61a7a5cdfc3461c1633e8736f",
        verificationKey: "QmZxQxY5aFD1uDyNqM363r12TCcW11JL3QFrPZk1DwsEkS",
        verificationKeySha256: "b798641ce2b9c702ce11449f051d8f936e328812695504fda4929f164a765d1d",
    },
    transact_5x2: {
        wasm: "QmafBCp4q6JBi32nf3mh9vRQweawDUinsnbE22LucwNdpX",
        wasmSha256: "0f17ff4ef508e5270445d8e31ba02a62e2f3a2641315de1fa3fc867d0204d3f3",
        provingKey: "QmXUNAF9ygw73jzXWt8EXnx1PgbYNK72axGw74eqb4Qbe5",
        provingKeySha256: "e2f5f69e7365e63329fc840974b4a6b0c13553b9829dc4c95f45fd71fbc86baa",
        verificationKey: "QmZ69Z1NPyic5CFMHNqLrRhWrk2MYwpdUY1pH9iQqHDnzc",
        verificationKeySha256: "3c5e01915d911b871f6f0842282f104a0fded5c3bf62f7f847ba1dfda8e510e9",
    },
    transact_5x3: {
        wasm: "Qmef2WUpyDhR5D7zKfuL1E5B74j6aULwy8LMjPoTqG7T8s",
        wasmSha256: "d81f31dbdf4fc280b0ef623aa59f7f9de654d5c823ddbf42a2887a48e867edfe",
        provingKey: "QmbN5PFBpVYxDpep1Ufx3daj4spMobrK2tgMMj7LA4faRg",
        provingKeySha256: "c9b2d185fea95ad798a6f8be531d7d4454aa5c4a6285a8c5ec1d9d4709487020",
        verificationKey: "QmfHaArVz3xVhsfP95cAkqbNJWTSUaGGf7c5NAPitWzGt5",
        verificationKeySha256: "18737c2c6862859010489e7f4801ed66d6987dd07e70131036136226d26d1f7e",
    },
    transact_5x4: {
        wasm: "QmVCaAbfa2X3kKwSdspdWsbxaymk9KGnR3CqD7M3sP5ysm",
        wasmSha256: "919b0f67f716b3ea8ad0ea193d99a780a9d0fea1f4061eab9a2a19002970ea73",
        provingKey: "QmYxpCDaTUezGY5biv3uzzm9ZY2muTtY67FfepX1hA7KwL",
        provingKeySha256: "3f974b64a084bfa5bcf2b1f700e643ea6b7bc37e35f30e588ef6b80e21d0ef5b",
        verificationKey: "QmaM7Unbaa3uV1E4nu8HB7fQG4We82CMUduj99NEXQzZ6i",
        verificationKeySha256: "d042860c5b0f6125370cdc308ea8216ce8b29879b0f6951248704c1b4b9ee795",
    },
    transact_5x5: {
        wasm: "QmT75hGWy2nHwzKytai279ZjAATiry6azbh2zra8dH7rva",
        wasmSha256: "b6c7632afb0624f09f1bd1c0a75e345a105a00e48ad4b545c03085292e37a188",
        provingKey: "QmeEnULbicqrkjPXX4ZjmNNGUKK7XyCRz2kfviGxXrRpvH",
        provingKeySha256: "7c70692fc7e41e7dec43159d18ca8aef73891f945e09019e4ebe5d7ea0673ed5",
        verificationKey: "QmdKsKq2BjxebvqxhdCQpCRuUhArRU48rmyQYWBs7bGR1N",
        verificationKeySha256: "8483810134671559f8ca3f35bb0da19e51feb6bc4efa573b44099789c07e33d9",
    },
};
