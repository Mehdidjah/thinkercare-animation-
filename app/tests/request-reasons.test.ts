import {expect, test} from 'bun:test';
import {REQUEST_REASONS, reasonFor} from '../src/terrain/domain/operations';

test('request reasons offered in the "Demande" form', () => {
  const labels = Object.values(REQUEST_REASONS).map((r) => r.label);
  for (const label of ['Habillage', 'Présentoir', 'Rupture de stock', 'Date d’expiration', 'Animation']) expect(labels).toContain(label);
  expect(labels.at(-1)).toBe('Autre — préciser');
  for (const key of ['habillage', 'presentoir', 'stockout', 'expiry_date', 'animation']) {
    expect(reasonFor('request', key)?.category).toBe('commercial');
    expect(reasonFor('complaint', key)).toBeUndefined();
  }
});
