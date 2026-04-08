/*
Copyright 2023 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
OF ANY KIND, either express or implied. See the License for the specific language
governing permissions and limitations under the License.
*/

const { resolve } = require("path");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const { aliases } = require("@swc-uxp-wrappers/utils");
const webpack = require("webpack");

// Legacy env var figyelmeztetés: a B.6 óta a VERIFICATION_URL és RECOVERY_URL
// a DASHBOARD_URL-ből származik. Ha valaki még a régi env változókat állítja
// (pl. CI script, lokális .env), figyelmeztetünk, hogy ezek némán ignorálódnak.
if (process.env.VERIFICATION_URL || process.env.RECOVERY_URL) {
  console.warn(
    '[webpack] FIGYELEM: A VERIFICATION_URL / RECOVERY_URL env változók már nem használtak. ' +
    'Használj DASHBOARD_URL-t helyette (pl. DASHBOARD_URL=http://localhost:5173). ' +
    'A build a DASHBOARD_URL fallback-jére (https://maestro.emago.hu) fog esni.'
  );
}

/**
 * === Copy static files configuration
 */
const copyStatics = {
  patterns: [
    {
      from: "manifest.json",
      context: resolve("./"),
      to: resolve("dist"),
    },
    {
      from: "src/assets/**/*",
      to: resolve("dist/assets/[name][ext]"),
      noErrorOnMissing: true,
    },
  ],
};

const shared = {
  mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  // Source maps engedélyezve: eval-cheap-source-map gyorsabb rebuild-eket biztosít fejlesztés közben
  devtool: 'eval-cheap-source-map',
  entry: resolve(__dirname, "src/core/index.js"),
  output: {
    path: resolve(__dirname, "dist"), // the bundle output path
    filename: "bundle.js", // the name of the bundle
    devtoolModuleFilenameTemplate: 'webpack:///[resource-path]'
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: "src/index.html", // to import index.html file inside index.js
    }),
    new CopyWebpackPlugin(copyStatics),
    new webpack.optimize.LimitChunkCountPlugin({
      maxChunks: 1,
    }),
    // Környezeti változók build-időben beégetve; ha nincs beállítva, undefined-ra értékelődik ki,
    // és az appwriteConfig.js fallback értéke (https://maestro.emago.hu) érvényesül.
    // A VERIFICATION_URL és RECOVERY_URL a DASHBOARD_URL-ből származtatva — nincs külön inject.
    new webpack.DefinePlugin({
      'process.env.DASHBOARD_URL': JSON.stringify(process.env.DASHBOARD_URL),
    }),
  ],
  devServer: {
    port: 3030, // you can change the port
  },
  module: {
    // A bignumber.js UMD modul AMD `define()`-t is tartalmaz.
    // noParse megakadályozza, hogy webpack AMD-ként kezelje → CJS `module.exports` útvonal fut le.
    noParse: /node_modules\/bignumber\.js\/bignumber\.js$/,
    rules: [
      {
        test: /\.(js|jsx)$/, // .js and .jsx files
        exclude: /node_modules/, // excluding the node_modules folder
        use: {
          loader: "babel-loader",
        },
      },
      {
        test: /\.(sa|sc|c)ss$/, // styles files
        use: ["style-loader", "css-loader", "sass-loader"],
      },
    ],
  },
  resolve: {
    extensions: [".js", ".jsx", ".json"],
    // Lokális node_modules elsőbbséget kap a root felett (Yarn workspaces kompatibilitás)
    modules: [resolve(__dirname, "node_modules"), "node_modules"],
    // Webpack 5: exports map feloldásához (SWC core/shared/ import-ok)
    conditionNames: ["import", "module", "browser", "default"],
    // SWC UXP wrappers alias-ok
    alias: {
        ...aliases,
        // A styles package régi subpath-jei nem szerepelnek az exports map-ben,
        // ezért fájlrendszer-alapú feloldás kell
        "@spectrum-web-components/styles": resolve(__dirname, "node_modules/@spectrum-web-components/styles"),
        // Közös csomag (maestro-shared) — a plugin és a dashboard által megosztott konstansok és logika
        "maestro-shared": resolve(__dirname, "../maestro-shared"),
        // A json-bigint (Appwrite SDK dependency) CJS require()-t használ a bignumber.js-hez.
        // A conditionNames: ["import", ...] beállítás miatt a webpack az ESM verzióra resolválna
        // (bignumber.mjs), de CJS require() hívás ESM default export-ra namespace objektumot kap
        // a konstruktor helyett → `instanceof BigNumber` TypeError. Explicit CJS-re kényszerítjük.
        "bignumber.js": resolve(__dirname, "node_modules/bignumber.js/bignumber.js"),
    },
  },
  externals: {
    'uxp': 'commonjs2 uxp',
    'indesign': 'commonjs2 indesign',
    'os': 'commonjs os',
  },
  performance: {
    maxEntrypointSize: 1500000, // 1.5 MB
    maxAssetSize: 1500000, // 1.5 MB
    hints: 'warning'
  },
  watchOptions: {
    ignored: /node_modules/,
  },
};

module.exports = shared;
