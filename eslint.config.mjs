import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config({ignores:['**/*.mjs','**/*.py']}, js.configs.recommended, ...ts.configs.recommended, {files:['**/*.ts'],rules:{'@typescript-eslint/no-explicit-any':'error','@typescript-eslint/no-unused-vars':['error',{argsIgnorePattern:'^_'}]}});
