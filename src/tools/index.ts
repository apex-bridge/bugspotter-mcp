import type { ToolDefinition } from '../types.js';
import { searchBugs } from './search-bugs.js';
import { findSimilar } from './find-similar.js';
import { getBug } from './get-bug.js';
import { listBugs } from './list-bugs.js';
import { updateBugStatus } from './update-bug-status.js';
import { ask } from './ask.js';

export const TOOLS: ToolDefinition[] = [
  searchBugs as ToolDefinition,
  findSimilar as ToolDefinition,
  getBug as ToolDefinition,
  listBugs as ToolDefinition,
  updateBugStatus as ToolDefinition,
  ask as ToolDefinition,
];
