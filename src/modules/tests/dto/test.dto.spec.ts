import { describe, expect, it } from 'vitest';
import { MAX_FORM_QUESTIONS, MAX_QUESTION_OPTIONS, putFormSchema } from './test.dto';

function openText(position: number) {
  return { type: 'open_text', prompt: `Pergunta ${position}`, required: false, position };
}

function choice(optionCount: number) {
  return {
    type: 'single_choice',
    prompt: 'Qual?',
    required: true,
    position: 0,
    options: Array.from({ length: optionCount }, (_, i) => ({ label: `Opção ${i}`, position: i })),
  };
}

describe('putFormSchema caps', () => {
  it(`accepts up to ${MAX_FORM_QUESTIONS} questions and refuses one more`, () => {
    const max = Array.from({ length: MAX_FORM_QUESTIONS }, (_, i) => openText(i));
    expect(putFormSchema.safeParse({ questions: max }).success).toBe(true);
    expect(
      putFormSchema.safeParse({ questions: [...max, openText(MAX_FORM_QUESTIONS)] }).success,
    ).toBe(false);
  });

  it(`accepts up to ${MAX_QUESTION_OPTIONS} options per question and refuses one more`, () => {
    expect(putFormSchema.safeParse({ questions: [choice(MAX_QUESTION_OPTIONS)] }).success).toBe(
      true,
    );
    expect(putFormSchema.safeParse({ questions: [choice(MAX_QUESTION_OPTIONS + 1)] }).success).toBe(
      false,
    );
  });
});
