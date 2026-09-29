/**
 * Shared view types for the voice console.
 *
 * These live in their own module so the sub-components (approval bar, settings)
 * can depend on the shapes without importing the console that composes them,
 * which would be a cycle.
 */

/** A selectable provider plus the models it exposes. */
export interface ChatProviderOption {
  id: string;
  label: string;
  models: string[];
}
