import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { AppShell } from "@/components/layout/AppShell";
import { authClient } from "@/lib/auth-client";
import { SignInPage } from "@/pages/auth/SignInPage";
import { BudgetCategoriesPage } from "@/pages/budget/CategoriesPage";
import { BudgetPage } from "@/pages/budget/BudgetPage";
import { ReceiptDetailPage } from "@/pages/budget/ReceiptDetailPage";
import { CategoriesPage } from "@/pages/categories/CategoriesPage";
import { ChatPage } from "@/pages/chat/ChatPage";
import { DocumentsPage } from "@/pages/documents/DocumentsPage";
import { DocumentDetailPage } from "@/pages/documents/DocumentDetailPage";
import { JobsPage } from "@/pages/jobs/JobsPage";
import { SearchPage } from "@/pages/search/SearchPage";
import { InboxPage } from "@/pages/inbox/InboxPage";
import { SettingsPage } from "@/pages/settings/SettingsPage";
import { SortingPage } from "@/pages/sorting/SortingPage";
import { TagsPage } from "@/pages/tags/TagsPage";
import { TypesPage } from "@/pages/types/TypesPage";
import { ForgotPasswordPage } from "@/pages/auth/ForgotPasswordPage";
import { ResetPasswordPage } from "@/pages/auth/ResetPasswordPage";

const queryClient = new QueryClient();

function RequireSession({ children }: { children: React.ReactNode }) {
  const { data, isPending } = authClient.useSession();
  if (isPending) return null;
  if (!data) return <Navigate to="/sign-in" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/sign-in" element={<SignInPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route
            element={
              <RequireSession>
                <AppShell />
              </RequireSession>
            }
          >
            <Route index element={<Navigate to="/inbox" replace />} />
            <Route path="/inbox" element={<InboxPage />} />
            <Route path="/documents" element={<DocumentsPage />} />
            <Route path="/documents/:id" element={<DocumentDetailPage />} />
            <Route path="/categories" element={<CategoriesPage />} />
            <Route path="/budget" element={<BudgetPage />} />
            <Route path="/budget/categories" element={<BudgetCategoriesPage />} />
            <Route path="/budget/receipts/:id" element={<ReceiptDetailPage />} />
            <Route path="/tags" element={<TagsPage />} />
            <Route path="/types" element={<TypesPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/sorting" element={<SortingPage />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/jobs" element={<JobsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
      <Toaster />
    </QueryClientProvider>
    </ThemeProvider>
  );
}
