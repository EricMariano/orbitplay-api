import { RATING_SCALE_BOUNDS } from '../tests/dto/test.dto';
import type { AnswerInput } from './dto/session.dto';
import type { FormQuestionWithOptions } from './participations.repository';

/** Same cap as a community post: long enough for feedback, bounded for the report. */
export const OPEN_TEXT_ANSWER_MAX_LENGTH = 5000;

export interface CheckedFormAnswers {
  /**
   * Answers that passed, one per question, blank ones dropped. A single
   * choice comes out as a one-item list: it's stored in `option_ids` like a
   * multiple choice, which is what the report counts and labels.
   */
  answers: AnswerInput[];
  /** `questionId → message`, the shape of the `422 fieldErrors` (Tela 18 RN-01). */
  fieldErrors: Record<string, string>;
}

/**
 * Tela 18: the DTO only knows an answer is a string, number, boolean or list.
 * This checks each one against the test's own questions — without it a
 * player could answer another test's question, answer one question many
 * times, or send a rating far outside the scale and skew (or, past int4,
 * break) the studio's report. A blank answer (empty text or list) counts as
 * unanswered, so it fails a required question and is dropped otherwise.
 */
export function checkFormAnswers(
  questions: FormQuestionWithOptions[],
  answers: AnswerInput[],
): CheckedFormAnswers {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const seen = new Set<string>();
  const accepted: AnswerInput[] = [];
  const fieldErrors: Record<string, string> = {};

  for (const answer of answers) {
    const question = byId.get(answer.questionId);
    if (!question) {
      fieldErrors[answer.questionId] = 'Pergunta não pertence a este formulário';
      continue;
    }
    if (seen.has(question.id)) {
      fieldErrors[question.id] = 'Pergunta respondida mais de uma vez';
      continue;
    }
    seen.add(question.id);
    if (isBlank(answer.value)) continue;

    const error = answerError(question, answer.value);
    if (error) fieldErrors[question.id] = error;
    else if (question.type === 'single_choice' && typeof answer.value === 'string') {
      accepted.push({ questionId: question.id, value: [answer.value] });
    } else accepted.push(answer);
  }

  for (const question of questions) {
    const answered = accepted.some((a) => a.questionId === question.id);
    if (question.required && !answered && !fieldErrors[question.id]) {
      fieldErrors[question.id] = 'Resposta obrigatória';
    }
  }

  return { answers: accepted, fieldErrors };
}

function isBlank(value: AnswerInput['value']): boolean {
  return (
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

function answerError(
  question: FormQuestionWithOptions,
  value: AnswerInput['value'],
): string | null {
  const isOption = (id: unknown) => question.options.some((o) => o.id === id);

  switch (question.type) {
    case 'open_text':
      if (typeof value !== 'string') return 'Resposta deve ser um texto';
      return value.length > OPEN_TEXT_ANSWER_MAX_LENGTH
        ? `Resposta deve ter no máximo ${OPEN_TEXT_ANSWER_MAX_LENGTH} caracteres`
        : null;
    case 'boolean':
      return typeof value === 'boolean' ? null : 'Resposta deve ser sim ou não';
    case 'scale':
    case 'nps': {
      // An NPS without its own range is 0–10, and so is a scale saved without one.
      const min = question.scaleMin ?? RATING_SCALE_BOUNDS.min;
      const max = question.scaleMax ?? RATING_SCALE_BOUNDS.max;
      const inScale =
        typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
      return inScale ? null : `Nota deve ser um número inteiro de ${min} a ${max}`;
    }
    case 'single_choice': {
      const optionId = Array.isArray(value) && value.length === 1 ? value[0] : value;
      return isOption(optionId) ? null : 'Opção inválida para esta pergunta';
    }
    case 'multiple_choice':
      return Array.isArray(value) && new Set(value).size === value.length && value.every(isOption)
        ? null
        : 'Opções inválidas para esta pergunta';
  }
}
