"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";

import { getStoredToken, login, storeToken } from "@/lib/api-client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const LandingPage = () => {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  // Already signed in (e.g. returning the same evening): skip the login form.
  useEffect(() => {
    if (getStoredToken() !== null) router.replace("/reconstruct");
  }, [router]);

  const loginMutation = useMutation({
    mutationFn: () => login(username.trim(), password),
    onSuccess: (response) => {
      // Token in localStorage for API calls (Authorization header) AND in the
      // blinks_token cookie so <img> requests to /frames/* are authenticated.
      storeToken(response.token);
      router.push("/reconstruct");
    },
  });

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (username.trim() === "" || password === "") return;
    loginMutation.mutate();
  };

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-2 text-center">
          <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
            Karlsruhe Institute of Technology · KD2Lab
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            BLINKS — Day Reconstruction
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Each evening of the study, please reconstruct your day as a
            sequence of activities. It takes about 10 minutes. Sign in with the
            participant credentials you received from the study team, then
            follow the steps on the next pages.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Participant sign-in</CardTitle>
            <CardDescription>
              Use the same credentials as in the BLINKS phone app.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username">Participant ID</Label>
                <Input
                  id="username"
                  name="username"
                  autoComplete="username"
                  autoFocus
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>

              {loginMutation.isError && (
                <Alert variant="destructive">
                  <AlertTitle>Sign-in failed</AlertTitle>
                  <AlertDescription>
                    {loginMutation.error instanceof Error
                      ? loginMutation.error.message
                      : "Please try again."}
                  </AlertDescription>
                </Alert>
              )}

              <Button
                type="submit"
                className="w-full"
                disabled={
                  loginMutation.isPending ||
                  username.trim() === "" ||
                  password === ""
                }
              >
                {loginMutation.isPending ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground">
          Questions or trouble signing in? Contact the study team.
        </p>
      </div>
    </main>
  );
};

export default LandingPage;
