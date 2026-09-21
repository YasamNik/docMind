import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

export function SignInPage() {
  const navigate = useNavigate();
  const { refetch: refetchSession } = authClient.useSession();
  const [hasUsers, setHasUsers] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ hasUsers: boolean }>("/api/auth/status").then((s) => setHasUsers(s.hasUsers));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = hasUsers
      ? await authClient.signIn.email({ email, password })
      : await authClient.signUp.email({ email, password, name: name || email });
    if (result.error) {
      setBusy(false);
      setError(result.error.message ?? "Sign in failed");
      return;
    }
    // The sign in request resolves before better-auth's session store refreshes.
    // Wait for the store itself to hold the new session, so the route guard sees
    // a real session on the very first navigation instead of a stale, empty one.
    await refetchSession();
    setBusy(false);
    navigate("/documents");
  }

  if (hasUsers === null) return null;

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">{hasUsers ? "Sign in to DocMind" : "Create your DocMind account"}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-3">
            {!hasUsers && (
              <div>
                <Label htmlFor="name">Name</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
            )}
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" required minLength={9} value={password} onChange={(e) => setPassword(e.target.value)} />
              {!hasUsers && <p className="text-xs text-muted-foreground mt-1">At least 9 characters. This is the only account; sign up closes after it.</p>}
              {hasUsers && (
                <Link to="/forgot-password" className="text-xs text-primary hover:underline mt-1 inline-block">
                  Forgot password?
                </Link>
              )}
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={busy}>
              {hasUsers ? "Sign in" : "Create account"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
