import { describe, expect, it } from 'vitest';
import { checkFormAnswers, OPEN_TEXT_ANSWER_MAX_LENGTH } from './form-answers';
import type { FormQuestionWithOptions } from './participations.repository';

function question(overrides: Partial<FormQuestionWithOptions> = {}): FormQuestionWithOptions {
  return {
    id: 'q-text',
    testId: 'test-1',
    type: 'open_text',
    label: 'O que achou?',
    helpText: null,
    required: false,
    position: 0,
    scaleMin: null,
    scaleMax: null,
    scaleMinLabel: null,
    scaleMaxLabel: null,
    options: [],
    ...overrides,
  };
}

const options = [
  { id: 'opt-a', questionId: 'q-choice', label: 'A', position: 0 },
  { id: 'opt-b', questionId: 'q-choice', label: 'B', position: 1 },
];
const text = question();
const scale = question({ id: 'q-scale', type: 'scale', scaleMin: 1, scaleMax: 5 });
const nps = question({ id: 'q-nps', type: 'nps' });
const single = question({ id: 'q-choice', type: 'single_choice', options });
const multiple = question({ id: 'q-choice', type: 'multiple_choice', options });
const yesNo = question({ id: 'q-bool', type: 'boolean' });

describe('checkFormAnswers', () => {
  it('accepts answers that fit their questions', () => {
    const answers = [
      { questionId: 'q-text', value: 'Muito bom' },
      { questionId: 'q-scale', value: 5 },
      { questionId: 'q-nps', value: 0 },
      { questionId: 'q-bool', value: false },
    ];
    expect(checkFormAnswers([text, scale, nps, yesNo], answers)).toEqual({
      answers,
      fieldErrors: {},
    });
  });

  it("rejects a question that isn't on this form", () => {
    const result = checkFormAnswers([text], [{ questionId: 'other-test-question', value: 'x' }]);
    expect(result.fieldErrors).toEqual({
      'other-test-question': 'Pergunta não pertence a este formulário',
    });
  });

  it('rejects answering the same question twice', () => {
    const result = checkFormAnswers(
      [scale],
      [
        { questionId: 'q-scale', value: 3 },
        { questionId: 'q-scale', value: 4 },
      ],
    );
    expect(result.fieldErrors['q-scale']).toBe('Pergunta respondida mais de uma vez');
  });

  it.each([6, 0, 2.5, 3_000_000_000, '3'])('rejects %s on a 1–5 scale', (value) => {
    const result = checkFormAnswers([scale], [{ questionId: 'q-scale', value }]);
    expect(result.fieldErrors['q-scale']).toBe('Nota deve ser um número inteiro de 1 a 5');
  });

  it('bounds an NPS without its own range to 0–10', () => {
    const result = checkFormAnswers([nps], [{ questionId: 'q-nps', value: 11 }]);
    expect(result.fieldErrors['q-nps']).toBe('Nota deve ser um número inteiro de 0 a 10');
  });

  it('only takes options of the question itself', () => {
    expect(
      checkFormAnswers([single], [{ questionId: 'q-choice', value: 'opt-b' }]).fieldErrors,
    ).toEqual({});
    expect(
      checkFormAnswers([single], [{ questionId: 'q-choice', value: 'opt-x' }]).fieldErrors,
    ).toEqual({
      'q-choice': 'Opção inválida para esta pergunta',
    });
    expect(
      checkFormAnswers([multiple], [{ questionId: 'q-choice', value: ['opt-a', 'opt-a'] }])
        .fieldErrors,
    ).toEqual({ 'q-choice': 'Opções inválidas para esta pergunta' });
  });

  it('stores a single choice as a one-option list, like a multiple choice', () => {
    expect(
      checkFormAnswers([single], [{ questionId: 'q-choice', value: 'opt-b' }]).answers,
    ).toEqual([{ questionId: 'q-choice', value: ['opt-b'] }]);
  });

  it('rejects a value of the wrong type and an oversized text', () => {
    const result = checkFormAnswers(
      [text, yesNo],
      [
        { questionId: 'q-text', value: 'x'.repeat(OPEN_TEXT_ANSWER_MAX_LENGTH + 1) },
        { questionId: 'q-bool', value: 'sim' },
      ],
    );
    expect(Object.keys(result.fieldErrors)).toEqual(['q-text', 'q-bool']);
  });

  it('treats a blank answer as unanswered', () => {
    const required = question({ required: true });
    expect(
      checkFormAnswers([required], [{ questionId: 'q-text', value: '   ' }]).fieldErrors,
    ).toEqual({
      'q-text': 'Resposta obrigatória',
    });
    expect(checkFormAnswers([text], [{ questionId: 'q-text', value: '' }])).toEqual({
      answers: [],
      fieldErrors: {},
    });
  });
});
