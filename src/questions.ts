// The judgment question catalog — every question in one place, with the pattern it
// follows. Changing a question here changes every consumer; link the relevant
// TypeSafe doc when you change a design.
import { choice, noul } from "@typesafe-ai/sdk";

/**
 * The primary judgment call for each step: three independent judgments over the
 * same state. A select action adds one second-stage call for its option (see
 * selectOptionQuestion), so "one call per step" means one primary call.
 * Patterns: fan-out (docs.typesafe.ai/patterns/fan-out.md) — the questions
 * cannot see each other's answers, which is what makes goal_done an honest
 * cross-check on the action Choice rather than a rationalization of it.
 */
export function stepQuestions(criteria: Record<string, string>) {
  return {
    action: choice("Which single action best advances the task on the current page?", criteria),
    goal_done: noul("The task's goal has been achieved: the current page and history show the sought outcome", {
      true: "The page being viewed is the sought destination or shows the sought information",
      false: "The goal is not yet achieved",
    }),
    stuck: noul("The actions so far are not making progress toward the task (repeats, loops, or no change)", {
      true: "Recent actions repeat or nothing changes; a different strategy is needed",
      false: "Progress is visible or the first steps are still reasonable",
    }),
  };
}

/**
 * Second stage for native <select> elements, asked only when the step Choice
 * picked select_eN. Option labels are the defined set; the model picks the value.
 * Two-stage pattern: docs.typesafe.ai (Choice cardinality is bounded at 255).
 */
export function selectOptionQuestion(elementDescription: string, options: string[]) {
  const criteria: Record<string, string> = {};
  options.forEach((label, i) => {
    criteria[`o${i}`] = label.slice(0, 80);
  });
  return choice(
    `Which option should be selected in the dropdown "${elementDescription}", given the task and the page?`,
    criteria,
  );
}
