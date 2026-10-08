// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { availableRoutes, contentRoute, registerRouteView } from './routes';

let off: (() => void) | undefined;
afterEach(() => {
  off?.();
  off = undefined;
});

describe('the route registry', () => {
  it('titles the three shipped routes as App did', () => {
    expect(contentRoute('models')?.title).toBe('Models');
    expect(contentRoute('scheduled')?.title).toBe('Scheduled');
    expect(contentRoute('connectors')?.title).toBe('Extensions');
    expect(contentRoute('chat')).toBeUndefined();
    expect(contentRoute('gallery')).toBeUndefined();
  });

  it('keeps the planned routes out of the app until a lane registers the screen', () => {
    expect(contentRoute('training')).toBeUndefined();
    expect(contentRoute('workflows')).toBeUndefined();
    expect(availableRoutes()).toEqual(['models', 'connectors', 'scheduled']);
    off = registerRouteView('training', () => null);
    expect(contentRoute('training')?.title).toBe('Training');
    expect(availableRoutes()).toEqual(['models', 'connectors', 'scheduled', 'training']);
  });
});
