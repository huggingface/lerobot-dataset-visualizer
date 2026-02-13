/**
 * Language instruction extraction utilities
 * Consolidates duplicated logic from fetch-data.ts
 */

/**
 * Extract language instructions from episode data rows
 * Consolidates logic from lines 232-258 and 573-626 in fetch-data.ts
 *
 * This function checks for language_instruction fields in the provided rows.
 * It supports both single and numbered language instruction fields
 * (language_instruction, language_instruction_2, language_instruction_3, etc.)
 *
 * @param episodeData - Array of episode data rows
 * @param sampleIndices - Indices of rows to check (default: [0] for first row only)
 * @returns Concatenated language instructions or undefined if none found
 */
export function extractLanguageInstructions(
  episodeData: Record<string, unknown>[],
  sampleIndices: number[] = [0],
): string | undefined {
  if (episodeData.length === 0) return undefined;

  const languageInstructions: string[] = [];

  // Check specified rows for instructions
  for (const idx of sampleIndices) {
    if (idx >= episodeData.length) continue;

    const row = episodeData[idx];

    // Check for primary language_instruction field
    if (
      "language_instruction" in row &&
      typeof row.language_instruction === "string" &&
      row.language_instruction
    ) {
      languageInstructions.push(row.language_instruction);

      // Check for numbered fields (language_instruction_2, _3, etc.)
      let instructionNum = 2;
      let key = `language_instruction_${instructionNum}`;
      while (key in row && typeof row[key] === "string") {
        languageInstructions.push(row[key] as string);
        instructionNum++;
        key = `language_instruction_${instructionNum}`;
      }

      // If we found instructions, stop searching other indices
      if (languageInstructions.length > 0) break;
    }
  }

  return languageInstructions.length > 0
    ? languageInstructions.join("\n")
    : undefined;
}

/**
 * Extract task from task_index by looking up in tasks metadata
 * Helper function for task extraction with proper type handling
 *
 * @param taskIndex - Task index (can be BigInt or number)
 * @param tasksData - Array of task metadata objects
 * @returns Task string or undefined if not found
 */
export function extractTaskFromMetadata(
  taskIndex: unknown,
  tasksData: Record<string, unknown>[],
): string | undefined {
  // Convert BigInt to number for comparison
  const taskIndexNum =
    typeof taskIndex === "bigint"
      ? Number(taskIndex)
      : typeof taskIndex === "number"
        ? taskIndex
        : undefined;

  if (taskIndexNum === undefined || taskIndexNum < 0) {
    return undefined;
  }

  if (taskIndexNum >= tasksData.length) {
    return undefined;
  }

  const taskData = tasksData[taskIndexNum];

  // Extract task from various possible fields
  if (
    taskData &&
    "__index_level_0__" in taskData &&
    typeof taskData.__index_level_0__ === "string"
  ) {
    return taskData.__index_level_0__;
  } else if (
    taskData &&
    "task" in taskData &&
    typeof taskData.task === "string"
  ) {
    return taskData.task;
  }

  return undefined;
}
