import { describe, expect, it } from 'vitest';
import { resultParameter, type InitiatorResultBody } from './daraja.js';

// ---------------------------------------------------------------------------
// Result callbacks are the only place a B2C payout or a reversal reports what
// actually happened, and their payload is a loosely-typed bag of key/value
// pairs whose contents differ per command. These cases are the shapes Safaricom
// really sends — including the ones that would throw if the bag were assumed to
// be a well-formed array.
// ---------------------------------------------------------------------------

function body(parameters?: InitiatorResultBody['Result']['ResultParameters']) {
  return {
    Result: {
      ResultType: 0,
      ResultCode: 0,
      ResultDesc: 'The service request is processed successfully.',
      OriginatorConversationID: '29112-34567890-1',
      ConversationID: 'AG_20240115_0000abc123',
      TransactionID: 'SBK1A2B3C4',
      ResultParameters: parameters,
    },
  } satisfies InitiatorResultBody;
}

describe('resultParameter', () => {
  it('reads a value out of the parameter bag', () => {
    const payload = body({
      ResultParameter: [
        { Key: 'TransactionAmount', Value: 2500 },
        { Key: 'TransactionReceipt', Value: 'SBK1A2B3C4' },
        { Key: 'ReceiverPartyPublicName', Value: '254712345678 - Jane Doe' },
      ],
    });

    expect(resultParameter(payload, 'TransactionAmount')).toBe(2500);
    expect(resultParameter(payload, 'ReceiverPartyPublicName')).toBe(
      '254712345678 - Jane Doe',
    );
  });

  it('returns undefined for a key this command does not send', () => {
    // A reversal result carries no TransactionAmount; a B2C one does. The same
    // reader has to serve both without throwing on the absent case.
    const payload = body({ ResultParameter: [{ Key: 'DebitAccountBalance', Value: '0' }] });

    expect(resultParameter(payload, 'TransactionAmount')).toBeUndefined();
  });

  it('survives a missing parameter bag', () => {
    // Failure results — and every timeout — arrive with no ResultParameters at
    // all. This is the case that would crash a destructuring reader, on exactly
    // the callback that reports a payout having failed.
    expect(resultParameter(body(), 'TransactionAmount')).toBeUndefined();
  });

  it('survives a bag that is not an array', () => {
    // Safaricom collapses a single-entry list into a bare object on some
    // products. Treating that as an array yields undefined rather than a throw.
    const malformed = {
      Result: {
        ...body().Result,
        ResultParameters: {
          ResultParameter: { Key: 'TransactionAmount', Value: 2500 },
        },
      },
    } as unknown as InitiatorResultBody;

    expect(resultParameter(malformed, 'TransactionAmount')).toBeUndefined();
  });

  it('survives an entirely empty body', () => {
    expect(resultParameter({} as InitiatorResultBody, 'TransactionAmount')).toBeUndefined();
  });
});
