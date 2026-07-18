const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const path = require('node:path');

module.exports = {
  output: {
    clean: true,
  },
  externals: [
    ({ request }, callback) => {
      if (
        request &&
        !request.startsWith('@pixaeron/') &&
        !request.startsWith('.') &&
        !path.isAbsolute(request)
      ) {
        return callback(null, `commonjs ${request}`);
      }

      callback();
    },
  ],
  plugins: [
    new NxAppWebpackPlugin({
      target: 'node',
      compiler: 'tsc',
      main: './src/main.ts',
      tsConfig: './tsconfig.app.json',
      assets: ['./src/assets'],
      optimization: false,
      outputHashing: 'none',
      sourceMap: true,
      externalDependencies: 'none',
      mergeExternals: true,
    }),
  ],
};
