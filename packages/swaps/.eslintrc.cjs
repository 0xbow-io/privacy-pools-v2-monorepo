/** @type {import('eslint').Linter.Config} */
module.exports = {
    parser: "@typescript-eslint/parser",
    parserOptions: {
        project: "tsconfig.eslint.json",
        tsconfigRootDir: __dirname,
        sourceType: "module",
    },
    plugins: ["@typescript-eslint/eslint-plugin"],
    extends: ["plugin:@typescript-eslint/recommended", "plugin:prettier/recommended"],
    root: true,
    env: {
        node: true,
        jest: true,
    },
    ignorePatterns: [".eslintrc.cjs", "*.json"],
    rules: {
        "@typescript-eslint/explicit-function-return-type": "error",
        "@typescript-eslint/explicit-module-boundary-types": "error",
        "@typescript-eslint/no-misused-promises": "error",
        "@typescript-eslint/no-floating-promises": "error",
        "@typescript-eslint/no-explicit-any": "error",
        "@typescript-eslint/no-unsafe-assignment": "warn",
        "@typescript-eslint/no-unsafe-argument": "warn",
        "@typescript-eslint/no-unsafe-member-access": "error",
        "@typescript-eslint/no-unsafe-return": "error",
        "@typescript-eslint/no-unused-vars": [
            "error",
            { argsIgnorePattern: "_+", ignoreRestSiblings: true },
        ],
        "@typescript-eslint/prefer-as-const": "warn",
        "@typescript-eslint/await-thenable": "error",
    },
    overrides: [
        {
            // Integration tests interact with external libs (circomlibjs, catch blocks)
            // that lack precise types — relax strictness for the test directory.
            files: ["test/**/*.ts"],
            rules: {
                "@typescript-eslint/explicit-function-return-type": "off",
                "@typescript-eslint/explicit-module-boundary-types": "off",
                "@typescript-eslint/no-explicit-any": "off",
                "@typescript-eslint/no-unsafe-assignment": "off",
                "@typescript-eslint/no-unsafe-argument": "off",
                "@typescript-eslint/no-unsafe-member-access": "off",
                "@typescript-eslint/no-unsafe-return": "off",
            },
        },
    ],
};
