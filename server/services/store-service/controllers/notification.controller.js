import {
  listNotificationsForRole,
  markNotificationsReadForRole,
} from "@deliverhub/server-platform/notifications/notification-center";

export async function listStoreNotifications(request, response) {
  response.json(await listNotificationsForRole("store", request.auth));
}

export async function markStoreNotificationsRead(request, response) {
  response.json(await markNotificationsReadForRole("store", request.auth));
}
