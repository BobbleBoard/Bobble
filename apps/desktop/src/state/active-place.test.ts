import { describe, expect, it } from 'vitest';
import { placeOf } from './active-place';

describe('placeOf — the one place the sidebar lights', () => {
  it('a studio is on screen over anything', () => {
    expect(placeOf('connectors', 'image')).toEqual({ kind: 'studio', studio: 'image' });
    expect(placeOf('chat', '3d')).toEqual({ kind: 'studio', studio: '3d' });
  });
  it('then a workspace screen', () => {
    expect(placeOf('models', 'chat')).toEqual({ kind: 'view', view: 'models' });
    expect(placeOf('scheduled', 'chat')).toEqual({ kind: 'view', view: 'scheduled' });
  });
  it('else the chat', () => {
    expect(placeOf('chat', 'chat')).toEqual({ kind: 'chat' });
  });
});
