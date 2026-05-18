/**
 * The `@handler` decorator (TC39 stage-3 flavor) registers methods
 * into a per-class registry the runtime invokes by name.
 *
 * Registration is lazy via `context.addInitializer`: it runs once
 * per instance creation, but the `hasOwnProperty` guard prevents
 * polluting parent constructors when a subclass is instantiated.
 *
 * The class-side static `_handlers` map is the runtime contract;
 * compile-time handler typing comes from the generated SDK `.d.ts`
 * (Phase 6.1), not from this decorator.
 */

export type HandlerFn<This = unknown, Args extends unknown[] = unknown[], R = unknown> = (
  this: This,
  ...args: Args
) => Promise<R> | R;

export type HandlerRegistry = Record<string, HandlerFn>;

interface HandlerCarrier {
  _handlers?: HandlerRegistry;
}

export function handler(name?: string) {
  return function decorate<This, Args extends unknown[], R>(
    method: HandlerFn<This, Args, R>,
    context: ClassMethodDecoratorContext<This, HandlerFn<This, Args, R>>,
  ): void {
    const handlerName = name ?? String(context.name);
    context.addInitializer(function (this: This) {
      const ctor = (this as { constructor: HandlerCarrier }).constructor;
      if (!Object.prototype.hasOwnProperty.call(ctor, '_handlers')) {
        ctor._handlers = {};
      }
      // Non-null: just installed above when missing.
      ctor._handlers![handlerName] = method as unknown as HandlerFn;
    });
  };
}

/** Read the handler registry attached to a class constructor. */
export function getHandlers(ctor: object): HandlerRegistry {
  return (ctor as HandlerCarrier)._handlers ?? {};
}
