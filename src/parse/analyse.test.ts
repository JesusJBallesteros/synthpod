import { describe, expect, it } from 'vitest';
import { detectLanguage, estimateSeconds, findWarnings } from './analyse';

const EN =
  'So let us start with something that is arguably overdue, which is to have you introduce yourself briefly to the listeners. Can you sketch your academic career so far, and say what your main research interests are? I thought I might want to be a filmmaker when I started.';
const DE =
  'Herzlich willkommen zu unserer Sendung. Was ist denn eigentlich passiert? Das war die seltsamste Woche meiner ganzen Laufbahn, ehrlich gesagt. Danach wurde es noch schlimmer, weil niemand mehr wusste, was zu tun war. Und wie ging es dann weiter?';
const ES =
  'Bienvenidos de nuevo al programa. Hoy vamos a hablar de lo que pasó la semana pasada, que fue realmente extraña para todos nosotros. Nadie sabía qué hacer y al final seguimos adelante esperando que todo se arreglara solo.';

describe('detectLanguage', () => {
  it('detects common languages with confidence', () => {
    expect(detectLanguage(EN.repeat(5))).toEqual({ family: 'en', confident: true });
    expect(detectLanguage(DE)).toEqual({ family: 'de', confident: true });
    expect(detectLanguage(`${ES} ${ES}`)).toEqual({ family: 'es', confident: true });
  });

  it('declines to guess from very little text', () => {
    expect(detectLanguage('Anna: Hi. Ben: Hello.')).toBeNull();
  });
});

describe('estimates and warnings', () => {
  it('estimates length from words and speed', () => {
    const turns = [{ speaker: 'A', text: Array(150).fill('word').join(' ') }];
    expect(estimateSeconds(turns, () => 1)).toBeCloseTo(60);
    expect(estimateSeconds(turns, () => 1.25)).toBeCloseTo(48);
  });

  it('warns about unlabelled text', () => {
    const warnings = findWarnings([
      { speaker: null, text: 'Teaser.' },
      { speaker: 'A', text: 'See https://example.org for more, e.g. the notes.' },
    ]);
    expect(warnings.map((w) => w.kind)).toEqual(['unlabelled']);
    expect(warnings[0].count).toBe(1);
  });
});
