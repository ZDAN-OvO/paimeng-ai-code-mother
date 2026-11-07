import next from 'eslint-config-next';
import nextTypescript from 'eslint-config-next/typescript';

export default [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'archive/**',
      'data/**',
      'runtime/**',
      'tmp/**',
      '.pi/**',
      '.archify/**',
      '.impeccable/**',
      'coverage/**',
      'test-results/**',
    ],
  },
  ...next,
  ...nextTypescript,
];
