/** `decide` was asked something it never does, whatever the configuration (plan change J3), or a use it may not make yet (J4). */
export class ForbiddenDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenDecisionError";
  }
}

/** A malformed question: too few or too many options, an empty text. */
export class DecisionQuestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionQuestionError";
  }
}

/** The site is configured `off`: the line does what it did before `decide`. */
export class DecisionOffError extends Error {
  constructor(site: string) {
    super(`decide is off at ${site}: the line keeps its own way of deciding`);
    this.name = "DecisionOffError";
  }
}

/** Jev takes at most 32k tokens of state and question; a longer request is refused, not sent in its slower long-context mode. */
export class DecisionTooLargeError extends Error {
  readonly tokens: number;
  constructor(tokens: number, limit: number) {
    super(`the request is about ${tokens} tokens, over the ${limit} Jev takes: refused rather than sent in the slower, less accurate long-context mode`);
    this.name = "DecisionTooLargeError";
    this.tokens = tokens;
  }
}
