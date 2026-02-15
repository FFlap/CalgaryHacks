import type {
  CorroborationItem,
  FactCheckMatch,
  VerificationStatus,
} from '@/lib/types';

function countCorroborationSignals(corroboration: {
  wikipedia: CorroborationItem[];
  wikidata: CorroborationItem[];
  pubmed: CorroborationItem[];
}): number {
  let signals = 0;
  if (corroboration.wikipedia.length > 0) signals += 1;
  if (corroboration.wikidata.length > 0) signals += 1;
  if (corroboration.pubmed.length > 0) signals += 1;
  return signals;
}

export function classifyVerificationStatus(input: {
  factChecks: FactCheckMatch[];
  corroboration: {
    wikipedia: CorroborationItem[];
    wikidata: CorroborationItem[];
    pubmed: CorroborationItem[];
  };
}): VerificationStatus {
  const tally = {
    supported: 0,
    contradicted: 0,
    contested: 0,
    unknown: 0,
  };

  for (const item of input.factChecks) {
    const verdict = item.normalizedVerdict;
    if (verdict === 'supported' || verdict === 'contradicted' || verdict === 'contested') {
      tally[verdict] += 1;
    } else {
      tally.unknown += 1;
    }
  }

  if (tally.contradicted > 0 && tally.supported === 0 && tally.contested === 0) {
    return {
      code: 'contradicted',
      label: 'Contradicted',
      reason: 'Independent fact-check publishers rate this claim as false or unsupported.',
      confidence: 'high',
    };
  }

  if (tally.supported > 0 && tally.contradicted === 0 && tally.contested === 0) {
    return {
      code: 'supported',
      label: 'Supported',
      reason: 'Independent fact-check publishers rate this claim as true or mostly true.',
      confidence: 'high',
    };
  }

  if (tally.supported + tally.contradicted + tally.contested > 0) {
    return {
      code: 'contested',
      label: 'Contested',
      reason: 'Fact-check verdicts are mixed, nuanced, or context-dependent across publishers.',
      confidence: 'medium',
    };
  }

  const signals = countCorroborationSignals(input.corroboration);

  if (signals >= 2) {
    return {
      code: 'unverified',
      label: 'Unverified',
      reason: 'No direct fact-check match found; trusted reference sources are provided for manual review.',
      confidence: 'low',
    };
  }

  return {
    code: 'unverified',
    label: 'Unverified',
    reason: 'No direct fact-check match or reliable corroboration was found for this claim.',
    confidence: 'low',
  };
}
