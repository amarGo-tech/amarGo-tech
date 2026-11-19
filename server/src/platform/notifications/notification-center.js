import { prisma } from "../../database/prisma.js";

const labelsByEvent = {
  "admin.registered": ["Шинэ админ бүртгэл", "Админ хэрэглэгч бүртгэгдлээ."],
  "admin.profile.updated": ["Админ профайл шинэчлэгдлээ", "Профайлын мэдээлэл өөрчлөгдлөө."],
  "courier.registered": ["Шинэ хүргэлтийн ажилтан", "Employee verification амжилттай бүртгэгдлээ."],
  "courier.status.updated": ["Employee төлөв шинэчлэгдлээ", "Хүргэлтийн ажилтны online/offline төлөв өөрчлөгдлөө."],
  "delivery.request.created": ["Шинэ хүргэлтийн хүсэлт", "Store шинэ хүргэлтийн хүсэлт үүсгэлээ."],
  "delivery.job.accepted": ["Хүргэлт хүлээн авлаа", "Employee хүргэлтийн ажлыг хүлээн авлаа."],
  "delivery.job.rejected": ["Хүргэлт татгалзлаа", "Employee хүргэлтийн хүсэлтээс татгалзлаа."],
  "delivery.job.arrived_store": ["Employee дэлгүүр дээр ирлээ", "Pickup verification эхлэхэд бэлэн боллоо."],
  "delivery.job.arrived_dropoff": ["Хүргэлтийн ажилтан ирлээ", "Баталгаажуулах код и-мэйлээр илгээгдлээ."],
  "delivery.job.pickup_verified": ["Pickup баталгаажлаа", "Store OTP баталгаажиж ачаа авлаа."],
  "delivery.job.dropoff_verified": ["Хүргэлт дууслаа", "Customer OTP баталгаажиж хүргэлт амжилттай дууслаа."],
};

function notificationCopy(event) {
  if (event.type === "order.paid") {
    const storeName = event.payload?.storeName ? String(event.payload.storeName) : "Дэлгүүр";
    const customerName = event.payload?.customerName ? String(event.payload.customerName) : "Хэрэглэгч";
    const totalMnt = Number(event.payload?.totalMnt ?? event.payload?.amountMnt ?? 0).toLocaleString("mn-MN");
    const orderNo = event.payload?.orderNo ?? event.payload?.orderId;
    // NOTE: keep the full id here (not a truncated suffix) - the store dashboard
    // parses this "#<id>" token out of the notification text to resolve the real
    // order/dispatch record. Truncating it breaks "Хүргэлт дуудах" for orders that
    // were opened from a notification instead of the live orders list.
    const orderSuffix = orderNo ? ` #${String(orderNo)}` : "";
    const itemSummary = Array.isArray(event.payload?.items)
      ? event.payload.items
        .map((item) => {
          const quantity = Number(item.quantity || 0);
          const amount = Number(item.amountMnt || 0).toLocaleString("mn-MN");
          return `${item.name} x${quantity} (${amount} MNT)`;
        })
        .join(", ")
      : "";
    const address = event.payload?.addressText ? ` Хаяг: ${String(event.payload.addressText)}.` : "";
    const itemsText = itemSummary ? ` Бараа: ${itemSummary}.` : "";

    return {
      title: `${storeName}: шинэ захиалга ирлээ`,
      body: `${customerName}${orderSuffix} захиалга төлбөрөөр баталгаажлаа. Нийт дүн: ${totalMnt} MNT.${itemsText}${address}`,
    };
  }

  const [title, body] = labelsByEvent[event.type] ?? ["Системийн мэдэгдэл", `${event.type} event ирлээ.`];
  return { title, body };
}

function audienceForRole(role) {
  if (role === "admin") return { channel: "ADMIN", tenantId: null };
  if (role === "store") return { channel: "STORE", tenantId: null };
  if (role === "courier") return { channel: "EMPLOYEE", tenantId: null };
  return { channel: "CUSTOMER", tenantId: null };
}

export async function createNotificationFromEvent(role, event = {}) {
  const { channel } = audienceForRole(role);
  let tenantId = null;
  const { title, body } = notificationCopy(event);
  let scopedUserId = null;
  const payload = event.payload ?? {};
  const order = payload.orderId ? await prisma.order.findUnique({
    where: { id: String(payload.orderId) },
    include: { customer: true, deliveryAssignments: { orderBy: { createdAt: "desc" }, take: 1, include: { employee: true } } },
  }) : null;
  if (role === "store") {
    const storeId = order?.storeId ?? payload.storeId;
    const store = storeId ? await prisma.store.findUnique({ where: { id: String(storeId) } }) : null;
    tenantId = store?.tenantId ?? null;
    scopedUserId = store?.id ?? null;
  } else if (role === "customer") {
    scopedUserId = order?.customer?.userId ?? null;
  } else if (role === "courier") {
    scopedUserId = order?.deliveryAssignments[0]?.employee?.userId
      ?? (String(event.source ?? "").startsWith("courier") ? payload.userId : null)
      ?? null;
  }
  // Unaddressed business events must never become global user notifications.
  if (role !== "admin" && !scopedUserId) return null;

  const existing = await prisma.notification.findFirst({
    where: {
      channel,
      tenantId,
      userId: scopedUserId,
      title,
      body,
    },
    orderBy: { createdAt: "desc" },
  });

  if (existing) return existing;

  return prisma.notification.create({
    data: {
      tenantId,
      userId: scopedUserId,
      title,
      body,
      channel,
      status: "SENT",
    },
  });
}

export function notificationWhere(role, { userId, tenantId, storeIds = [] } = {}) {
  const { channel } = audienceForRole(role);
  if (role === "admin") return { channel };
  if (role === "store" && tenantId) {
    return { channel, OR: [{ tenantId }, { userId: { in: storeIds } }] };
  }
  if (role !== "store" && userId) return { channel, userId };
  throw Object.assign(new Error("Notification audience required"), { statusCode: 403, code: "FORBIDDEN" });
}

async function scopedNotificationWhere(role, scope) {
  if (role === "store" && scope.tenantId) {
    const stores = await prisma.store.findMany({ where: { tenantId: scope.tenantId }, select: { id: true } });
    return notificationWhere(role, { ...scope, storeIds: stores.map((store) => store.id) });
  }
  return notificationWhere(role, scope);
}

export async function listNotificationsForRole(role, { limit = 20, ...scope } = {}) {
  const where = await scopedNotificationWhere(role, scope);
  const notifications = await prisma.notification.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return {
    unreadCount: notifications.filter((notification) => !notification.readAt).length,
    items: notifications.map((notification) => ({
      id: notification.id,
      title: notification.title,
      body: notification.body,
      channel: notification.channel,
      status: notification.status,
      storeId: notification.channel === "STORE" ? notification.userId : undefined,
      readAt: notification.readAt?.toISOString() ?? null,
      createdAt: notification.createdAt.toISOString(),
    })),
  };
}

export async function markNotificationsReadForRole(role, scope = {}) {
  const where = await scopedNotificationWhere(role, scope);
  await prisma.notification.updateMany({
    where: { ...where, readAt: null },
    data: { status: "READ", readAt: new Date() },
  });

  return listNotificationsForRole(role, scope);
}
