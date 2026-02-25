//@ts-check

"use strict";

const path = require("path");
const CopyWebpackPlugin = require("copy-webpack-plugin");

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const config = {
    target: "node",
    mode: "none",

    entry: "./src/extension.ts",
    output: {
        path: path.resolve(__dirname, "dist"),
        filename: "extension.js",
        libraryTarget: "commonjs2",
    },
    externals: {
        vscode: "commonjs vscode",
        // Don't bundle these Node.js native modules
        "utf-8-validate": "commonjs utf-8-validate",
        bufferutil: "commonjs bufferutil",
        // Note: dugite and tar are bundled by webpack (their JS source is small).
        // dugite's binary is NOT bundled — it downloads at runtime via gitBinaryManager.
    },
    resolve: {
        extensions: [".ts", ".js"],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: [
                    {
                        loader: "ts-loader",
                    },
                ],
            },
        ],
    },
    experiments: {
        asyncWebAssembly: true,
    },
    plugins: [
        new CopyWebpackPlugin({
            patterns: [
                {
                    from: "src/git/askpass.js",
                    to: "askpass.js",
                },
            ],
        }),
    ],
    ignoreWarnings: [/Critical dependency/],
    devtool: "nosources-source-map",
    infrastructureLogging: {
        level: "log",
    },
};

module.exports = config;
