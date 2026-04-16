/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  moduleNameMapper: {
    "^vscode$": "<rootDir>/src/__mocks__/vscode.ts",
  },
  globals: {
    "ts-jest": {
      tsconfig: {
        module: "commonjs",
        target: "ES2020",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
      },
    },
  },
};
