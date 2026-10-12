const path = require('path');
const webpack = require('webpack');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = {
    mode: 'production', // 또는 'development'
    entry: './src/main.js',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'plugin.js',
        library: 'webdataVcs',
        libraryTarget: 'umd',
        globalObject: 'this'
    },
    module: {
        rules: [
            {
                test: /\.js$/,
                exclude: /node_modules/,
                use: {
                    loader: 'babel-loader',
                    options: {
                        presets: ['@babel/preset-env']
                    }
                }
            },
            {
                // CodeMirror CSS 를 런타임에 <style> 로 주입 (plugin.js 단일 파일 자급자족)
                test: /\.css$/,
                use: ['style-loader', 'css-loader']
            }
        ]
    },
    plugins: [
        // CodeMirror merge 애드온은 diff_match_patch / DIFF_* 를 전역으로 참조 → 번들 내부에서만 주입 (window 오염 없음)
        new webpack.ProvidePlugin({
            diff_match_patch: ['diff-match-patch', 'diff_match_patch'],
            DIFF_INSERT: ['diff-match-patch', 'DIFF_INSERT'],
            DIFF_DELETE: ['diff-match-patch', 'DIFF_DELETE'],
            DIFF_EQUAL: ['diff-match-patch', 'DIFF_EQUAL']
        })
    ],
    optimization: {
        minimize: true,
        minimizer: [
            new TerserPlugin({
                extractComments: false,
                terserOptions: {
                    format: {
                        comments: false
                    }
                }
            })
        ]
    }
};
