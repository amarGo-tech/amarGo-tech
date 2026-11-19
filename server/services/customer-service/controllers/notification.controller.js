import {
  listNotificationsForRole,
  markNotificationsReadForRole,
} from "@deliverhub/server-platform/notifications/notification-center";

export async function listCustomerNotifications(request, response) {
  response.json(await listNotificationsForRole("customer", request.auth));
}

export async function markCustomerNotificationsRead(request, response) {
  response.json(await markNotificationsReadForRole("customer", request.auth));
}
