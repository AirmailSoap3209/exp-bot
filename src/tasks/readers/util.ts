/** Result for a metric the reader doesn't recognise. A test checks no catalogue task hits this. */
export const unknownMetric = (metric: string) => ({ kind: 'unavailable' as const, reason: `Reader does not know metric ${metric}` });
