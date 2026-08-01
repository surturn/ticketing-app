import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import { SignInPanel } from '@/auth/SignInPanel';
import { Skeleton } from '@/components/ui';

/**
 * Sign in, on its own route so it can be linked to and returned from.
 *
 * Signing in sends the buyer on to their tickets rather than leaving them on a
 * form they have already completed — the reason anyone signs in here is to see
 * what they have bought.
 */
export function SignInPage() {
  const { status } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    // `replace` so the back button returns to wherever they came from, not to a
    // sign-in screen they can no longer use.
    if (status === 'signed-in') navigate('/account', { replace: true });
  }, [status, navigate]);

  if (status === 'loading' || status === 'signed-in') {
    return (
      <div className="mx-auto max-w-sm space-y-3">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-12 w-full rounded-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-sm py-8">
      <SignInPanel />
    </div>
  );
}
