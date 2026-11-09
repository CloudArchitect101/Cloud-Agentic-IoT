import type { RouteObject } from 'react-router';
import Home from './pages/Home';
import NotFound from './pages/NotFound';
import Login from "./features/authentication/pages/Login";
import ForgotPassword from "./features/authentication/pages/ForgotPassword";
import ResetPassword from "./features/authentication/pages/ResetPassword";
import Profile from "./features/authentication/pages/Profile";
import ChangePassword from "./features/authentication/pages/ChangePassword";
import PrivateRoute from "./features/authentication/layouts/privateRouteLayout";
import { ROUTES } from "./features/authentication/authenticationConfig";
import AuthAppLayout from "./features/authentication/layouts/AuthAppLayout";

export const routes: RouteObject[] = [
  {
    path: "/",
    element: <AuthAppLayout />,
    children: [
      {
        path: ROUTES.LOGIN.PATH,
        element: <Login />,
        handle: { showInNavigation: false, label: "Login", title: ROUTES.LOGIN.TITLE }
      },
      {
        path: ROUTES.FORGOT_PASSWORD.PATH,
        element: <ForgotPassword />,
        handle: { showInNavigation: false, title: ROUTES.FORGOT_PASSWORD.TITLE }
      },
      {
        path: ROUTES.RESET_PASSWORD.PATH,
        element: <ResetPassword />,
        handle: { showInNavigation: false, title: ROUTES.RESET_PASSWORD.TITLE }
      },
      {
        element: <PrivateRoute />,
        children: [
          {
            index: true,
            element: <Home />,
            handle: { showInNavigation: true, label: "My room", title: "My room | Patient Portal" }
          },
          {
            path: ROUTES.PROFILE.PATH,
            element: <Profile />,
            handle: { showInNavigation: false, label: "Profile", title: ROUTES.PROFILE.TITLE }
          },
          {
            path: ROUTES.CHANGE_PASSWORD.PATH,
            element: <ChangePassword />,
            handle: { showInNavigation: false, title: ROUTES.CHANGE_PASSWORD.TITLE }
          }
        ]
      },
      {
        path: '*',
        element: <NotFound />
      }
    ]
  }
];
