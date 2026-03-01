export type TddState =
  | 'idle'
  | 'planning'
  | 'test_writing'
  | 'test_running'
  | 'coding'
  | 'done'
  | 'failed';

export type SessionMode = 'strict' | 'explore' | 'debug';

export interface SessionState {
  state: TddState;
  mode: SessionMode;
  previous_state: TddState | null;
  consecutive_failures: number;
  test_files: string[];
  last_test_passed: boolean | null;
}

export type ToolName =
  | 'fs.read'
  | 'fs.write'
  | 'fs.list'
  | 'fs.exists'
  | 'search.grep'
  | 'search.glob'
  | 'test.run'
  | 'shell.exec';

export interface ToolGateQuery {
  tool: ToolName;
  target_path?: string;
}

export const EXEMPT_PATTERNS: string[] = [
  '*.json', '*.yml', '*.yaml', '*.toml',
  '*.md', '*.txt',
  'Dockerfile*', '.dockerignore',
  '.gitignore', '.env*',
];

export const TEST_FILE_PATTERNS: string[] = [
  '**/*.test.ts', '**/*.test.js', '**/*.spec.ts', '**/*.spec.js',
  'test/**', 'tests/**', '__tests__/**',
];

export const INITIAL_SESSION_STATE: SessionState = {
  state: 'idle',
  mode: 'strict',
  previous_state: null,
  consecutive_failures: 0,
  test_files: [],
  last_test_passed: null,
};
