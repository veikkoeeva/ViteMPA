// vite.config.js
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({

	base: './',

	// Root directory containing your source files
	root: 'public',

	// Log level configuration
	logLevel: 'info',

	// Build configuration
	build: {
		// Output directory relative to project root
		outDir: './dist',
		// Empty the outDir on build
		emptyOutDir: true,
		// Sourcemap generation
		sourcemap: true,
		crossOrigin: false,
		publicDir: false, // Disable default publicDir behavior
		server: {
			fs: {
				allow: ['./public', '../AITest/src/AITest.Web/bin/Debug/net9.0'] // Allows serving files from these dirs
			}
		},
		rollupOptions: {
			input: {
				main: resolve(__dirname, 'public/index.html'),
				another: resolve(__dirname, 'public/another-page.html')
			}
		}
	},

	// Asset handling
	assetsInclude: ['**/*.jpg', '**/*.png', '**/*.svg', '**/*.gif'],

	plugins: [
		{
			name: 'remove-crossorigin',
			transformIndexHtml(html) {
				console.log('Transforming HTML:', html); // Log the HTML before modification
				const modifiedHtml = html.replace(/\s+crossorigin(="[^"]*")?/g, ''); // Remove 'crossorigin' attributes
				console.log('Modified HTML:', modifiedHtml); // Log the HTML after modification
				return modifiedHtml;
			},
		}
	],

	// Development server configuration
	server: {
		host: 'localhost',
		open: '/index.html'
	},

	// Preview server configuration
	preview: {
		host: 'localhost',
		base: './'
	}
})
