export const SCORE_SCALE = 100;

export type McqScoringSnapshot = {
  correctMarks: number;
  incorrectMarks: number;
  unansweredMarks: number;
};

export type McqQuestionSnapshot = {
  questionId: string;
  correctOptionId?: string;
};

export type McqSubmissionAnswer = {
  questionId: string;
  selectedOptionId: string | null;
};

export type McqScoreResult = {
  score: number;
  maxScore: number;
  scoringSnapshot: McqScoringSnapshot;
  metrics: {
    correctCount: number;
    incorrectCount: number;
    unansweredCount: number;
  };
};

export class McqScoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McqScoringError';
  }
}

export function toScoreHundredths(value: number): number {
  if (!Number.isFinite(value)) {
    throw new McqScoringError('Score component is not a finite number.');
  }

  return Math.round(value * SCORE_SCALE);
}

export function fromScoreHundredths(hundredths: number): number {
  return hundredths / SCORE_SCALE;
}

export function normalizeScore(value: number): number {
  return fromScoreHundredths(toScoreHundredths(value));
}

export function isTwoDecimalScore(value: number): boolean {
  if (!Number.isFinite(value)) {
    return false;
  }

  return Math.abs(value - normalizeScore(value)) < 1e-9;
}

export function snapshottedMaxScore(
  scoring: { maxScore?: number } | null | undefined,
): number | null {
  if (scoring?.maxScore == null || !Number.isFinite(scoring.maxScore) || scoring.maxScore <= 0) {
    return null;
  }

  return normalizeScore(scoring.maxScore);
}

export function scoreMcqSubmission(
  questions: McqQuestionSnapshot[],
  answers: McqSubmissionAnswer[],
  scoring: McqScoringSnapshot,
): McqScoreResult {
  if (questions.length === 0) {
    throw new McqScoringError('Attempt question snapshot has no questions to score.');
  }

  if (
    !Number.isFinite(scoring.correctMarks) ||
    !Number.isFinite(scoring.incorrectMarks) ||
    !Number.isFinite(scoring.unansweredMarks)
  ) {
    throw new McqScoringError('Attempt scoring snapshot is incomplete.');
  }

  const answerByQuestion = new Map(
    answers.map((answer) => [answer.questionId, answer.selectedOptionId]),
  );

  let correctCount = 0;
  let incorrectCount = 0;
  let unansweredCount = 0;
  let scoreHundredths = 0;

  const correctHundredths = toScoreHundredths(scoring.correctMarks);
  const incorrectHundredths = toScoreHundredths(scoring.incorrectMarks);
  const unansweredHundredths = toScoreHundredths(scoring.unansweredMarks);

  for (const question of questions) {
    if (!question.correctOptionId) {
      throw new McqScoringError('Attempt question snapshot is missing a server-side answer key.');
    }

    const selected = answerByQuestion.get(question.questionId);

    if (selected == null || selected === '') {
      unansweredCount += 1;
      scoreHundredths += unansweredHundredths;
      continue;
    }

    if (selected === question.correctOptionId) {
      correctCount += 1;
      scoreHundredths += correctHundredths;
      continue;
    }

    incorrectCount += 1;
    scoreHundredths += incorrectHundredths;
  }

  return {
    score: fromScoreHundredths(scoreHundredths),
    maxScore: fromScoreHundredths(correctHundredths * questions.length),
    scoringSnapshot: {
      correctMarks: fromScoreHundredths(correctHundredths),
      incorrectMarks: fromScoreHundredths(incorrectHundredths),
      unansweredMarks: fromScoreHundredths(unansweredHundredths),
    },
    metrics: {
      correctCount,
      incorrectCount,
      unansweredCount,
    },
  };
}
