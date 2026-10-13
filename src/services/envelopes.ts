/**
 * DSH Protocol Envelope builder matching Envelopes.kt
 */

export const Envelopes = {
  TYPE_CLIENT_REQUEST: 'client-request',

  toEndpoint(dotted: string): string {
    const i = dotted.indexOf('.');
    return i < 0 ? dotted : dotted.substring(0, i) + '/' + dotted.substring(i + 1);
  },

  clientRequest(rpcId: string, method: string, args: Record<string, unknown>) {
    return {
      type: this.TYPE_CLIENT_REQUEST,
      rpcId,
      method: this.toEndpoint(method),
      payload: {
        args,
      },
    };
  },

  approvalOutcome(allow: boolean) {
    return {
      kind: 'result',
      value: allow ? 'allowed-once' : 'rejected',
    };
  },

  questionOutcome(questionId: string, selected: string[]) {
    return {
      kind: 'result',
      value: {
        answers: [
          {
            id: questionId,
            selected,
          },
        ],
      },
    };
  },

  rejected(message: string, code?: string) {
    return {
      kind: 'rejected',
      error: {
        name: 'Error',
        message,
        code,
      },
    };
  },
};
