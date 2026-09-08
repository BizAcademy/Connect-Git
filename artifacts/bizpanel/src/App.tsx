import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { PageMessages } from "@/lib/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/hooks/useAuth";
import { LogoLoader } from "@/components/ui/LogoLoader";

import Index from "./pages/Index";

const Auth = lazy(() => import("./pages/Auth"));
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
const Admin = lazy(() => import("./pages/Admin"));
const NotFound = lazy(() => import("./pages/NotFound"));
const DashboardLayout = lazy(() =>
  import("./components/dashboard/DashboardLayout").then((module) => ({
    default: module.DashboardLayout,
  })),
);
const DashboardHome = lazy(() => import("./pages/dashboard/Home"));
const NewOrder = lazy(() => import("./pages/dashboard/NewOrder"));
const OrderProviderSelect = lazy(() => import("./pages/dashboard/OrderProviderSelect"));
const MyOrders = lazy(() => import("./pages/dashboard/MyOrders"));
const Deposit = lazy(() => import("./pages/dashboard/Deposit"));
const PaymentHistory = lazy(() => import("./pages/dashboard/PaymentHistory"));
const Transactions = lazy(() => import("./pages/dashboard/Transactions"));
const Refunds = lazy(() => import("./pages/dashboard/Refunds"));
const Affiliation = lazy(() => import("./pages/dashboard/Affiliation"));
const Support = lazy(() => import("./pages/dashboard/Support"));
const CancelOrder = lazy(() => import("./pages/dashboard/CancelOrder"));

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <PageMessages />

      <BrowserRouter>
        <AuthProvider>
          <Suspense fallback={<LogoLoader fullPage />}>
            <Routes>
              <Route path="/" element={<Index />} />
              <Route path="/auth" element={<Auth />} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route path="/admin" element={<Admin />} />

              <Route path="/dashboard" element={<DashboardLayout />}>
                <Route index element={<DashboardHome />} />
                <Route path="order" element={<OrderProviderSelect />} />
                <Route path="order/:providerId" element={<NewOrder />} />
                <Route path="orders" element={<MyOrders />} />
                <Route path="orders/cancel/:orderId" element={<CancelOrder />} />
                <Route path="deposit" element={<Deposit />} />
                <Route path="payments" element={<PaymentHistory />} />
                <Route path="transactions" element={<Transactions />} />
                <Route path="refunds" element={<Refunds />} />
                <Route path="affiliation" element={<Affiliation />} />
                <Route path="support" element={<Support />} />
              </Route>

              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
