import {
  listNotificationsForRole,
  markNotificationsReadForRole,
} from "@deliverhub/server-platform/notifications/notification-center";

export async function listCourierNotifications(request, response) {
  response.json(await listNotificationsForRole("courier", request.auth));
}

export async function markCourierNotificationsRead(request, response) {
  response.json(await markNotificationsReadForRole("courier", request.auth));
}
