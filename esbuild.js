const esbuild = require('esbuild');

const production = process.argv.includes('--production');

async function main() {
    const ctx = await esbuild.context({
        entryPoints: ['src/extension.ts'],
        bundle: true,
        external: ['vscode'],
        format: 'cjs',
        target: 'ES2020',
        outdir: 'out',
        sourcemap: !production,
        minify: production,
        platform: 'node',
        logLevel: 'info',
        plugins: [nodeModulesPlugin],
    });
    if (production) {
        await ctx.rebuild();
        process.exit(0);
    } else {
        await ctx.watch();
    }
}

const nodeModulesPlugin = {
    name: 'node-modules',
    setup(build) {
        build.onResolve({ filter: /^node:/ }, (args) => ({
            path: args.path.replace(/^node:/, ''),
            external: true,
        }));
    },
};

main().catch((e) => {
    console.error(e);
    process.exit(1);
});