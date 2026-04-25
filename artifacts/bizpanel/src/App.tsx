import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/hooks/useAuth";

import Index from "./pages/Index";
import Auth from "./pages/Auth";
import ResetPassword from "./pages/ResetPassword";
import Admin from "./pages/Admin";
import NotFound from "./pages/NotFound";
import { DashboardLayout } from "./components/dashboard/DashboardLayout";
import DashboardHome from "./pages/dashboard/Home";
import NewOrder from "./pages/dashboard/NewOrder";
import OrderProviderSelect from "./pages/dashboard/OrderProviderSelect";
import MyOrders from "./pages/dashboard/MyOrders";
import Deposit from "./pages/dashboard/Deposit";
import PaymentHistory from "./pages/dashboard/PaymentHistory";
import Transactions from "./pages/dashboard/Transactions";
import Support from "./pages/dashboard/Support";
import CancelOrder from "./pages/dashboard/CancelOrder";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
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
              <Route path="support" element={<Support />} />
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
