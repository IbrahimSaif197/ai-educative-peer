/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  // media/*.js is loaded through `new Function` in webviewMain.test.ts, so
  // istanbul cannot instrument it; only the TypeScript sources are measured.
  collectCoverageFrom: ["src/**/*.ts", "!src/__tests__/**", "!src/__mocks__/**"],
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
