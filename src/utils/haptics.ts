/**
 * Haptic feedback utility for mobile web & hybrid apps.
 * Triggers subtle vibration pulses on Android/iOS devices that support navigator.vibrate.
 */
export type HapticStyle = 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error' | 'selection';

export function triggerHaptic(style: HapticStyle = 'light'): void {
  try {
    if (typeof window === 'undefined' || !window.navigator || !('vibrate' in window.navigator)) {
      return;
    }

    switch (style) {
      case 'light':
      case 'selection':
        window.navigator.vibrate(8);
        break;
      case 'medium':
        window.navigator.vibrate(15);
        break;
      case 'heavy':
        window.navigator.vibrate(25);
        break;
      case 'success':
        // Double tap pulse
        window.navigator.vibrate([10, 30, 15]);
        break;
      case 'warning':
        window.navigator.vibrate([15, 40, 15]);
        break;
      case 'error':
        // Triple short pulse
        window.navigator.vibrate([20, 40, 20, 40, 20]);
        break;
      default:
        window.navigator.vibrate(10);
    }
  } catch {
    // Graceful silent ignore if vibrating is blocked by system policies
  }
}
