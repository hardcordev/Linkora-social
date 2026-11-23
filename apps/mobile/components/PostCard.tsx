import React, { useEffect, useMemo, useState } from "react";
import {
  GestureResponderEvent,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  AccessibilityInfo,
  Image,
  TextInput,
} from "react-native";
import Animated, {
  useSharedValue,
  withTiming,
  withSpring,
} from "react-native-reanimated";
import { useRouter } from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { PanGestureHandler } from "react-native-gesture-handler";

import { useLike } from "../hooks/useLike";
import { useTheme } from "../theme/useTheme";
import { impact } from "../utils/haptics";
import { useHapticSettings } from "../hooks/useHapticSettings";
import { PostCardSkeleton as SharedPostCardSkeleton } from "./skeletons/PostCardSkeleton";

export { SharedPostCardSkeleton as PostCardSkeleton };

export interface Post {
  id: number | string;
  author: string;
  username: string;
  content: string;
  tip_total: number;
  timestamp: number;
  like_count: number;
  has_liked?: boolean;
  sync_status?: "synced" | "pending" | "failed";
}

interface FeedPostCardProps {
  post: Post;
  onPress?: () => void;
}

interface LegacyPostCardProps {
  id: number | string;
  author: string;
  content: string;
  timestamp: string | number;
  likes?: number;
  hasLiked?: boolean;
  isLoading?: boolean;
  onPress?: () => void;
}

type PostCardProps = FeedPostCardProps | LegacyPostCardProps;

const SWIPE_THRESHOLD = 80;
const TIP_QUICK_AMOUNTS = [0.1, 1, 5];

/**
 * Earliest plausible seconds-since-epoch (2001-09-09). A Stellar ledger sequence
 * is around 5x10^7, so any value below this is a unit mix-up, not a time.
 */
const MIN_PLAUSIBLE_TIMESTAMP = 1_000_000_000;

function formatTimestamp(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0 || ts < MIN_PLAUSIBLE_TIMESTAMP) return "";
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 0) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 86400)}d ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function normalizePost(props: PostCardProps): { post: Post; timeLabel?: string } {
  if ("post" in props) {
    return { post: props.post };
  }

  return {
    post: {
      id: props.id,
      author: props.author,
      username: props.author,
      content: props.content,
      tip_total: 0,
      timestamp: typeof props.timestamp === "number" ? props.timestamp : 0,
      like_count: props.likes ?? 0,
      has_liked: props.hasLiked ?? false,
    },
    timeLabel: typeof props.timestamp === "string" ? props.timestamp : undefined,
  };
}

function createStyles(theme: ReturnType<typeof useTheme>["theme"]) {
  return StyleSheet.create({
    card: {
      backgroundColor: theme.colors.surface.surface1,
      borderRadius: 12,
      padding: 16,
      marginHorizontal: 16,
      marginVertical: 6,
      borderWidth: 1,
      borderColor: theme.colors.surface.border,
    },
    skeleton: {
      opacity: 0.8,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      marginBottom: 10,
    },
    avatar: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: theme.colors.brand.primary,
      alignItems: "center",
      justifyContent: "center",
      marginRight: 10,
    },
    avatarText: {
      color: theme.colors.text.onBrand,
      fontWeight: "700",
      fontSize: 16,
    },
    meta: {
      flex: 1,
    },
    username: {
      color: theme.colors.text.primary,
      fontWeight: "600",
      fontSize: 14,
    },
    address: {
      color: theme.colors.text.secondary,
      fontSize: 11,
      fontFamily: "monospace",
    },
    time: {
      color: theme.colors.text.secondary,
      fontSize: 11,
    },
    timeContainer: {
      alignItems: "flex-end",
    },
    pendingBadge: {
      fontSize: 9,
      color: theme.colors.text.secondary,
      marginTop: 2,
    },
    failedBadge: {
      fontSize: 9,
      color: theme.colors.semantic?.error ?? "#EF4444",
      fontWeight: "700",
      marginTop: 2,
    },
    content: {
      color: theme.colors.text.primary,
      fontSize: 14,
      lineHeight: 20,
    },
    footer: {
      flexDirection: "row",
      alignItems: "center",
      marginTop: 12,
      gap: 16,
    },
    likeButton: {
      minHeight: 32,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.colors.surface.border,
      paddingHorizontal: 12,
      alignItems: "center",
      justifyContent: "center",
    },
    likeButtonLiked: {
      borderColor: theme.colors.brand.primary,
      backgroundColor: theme.colors.brand.primaryLight,
    },
    likeButtonPressed: {
      opacity: 0.82,
    },
    likeInner: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    likeIcon: {
      fontSize: 16,
      color: theme.colors.text.secondary,
      lineHeight: 18,
    },
    likeIconLiked: {
      color: theme.colors.brand.primary,
    },
    likeBadge: {
      minWidth: 22,
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: 999,
      backgroundColor: theme.colors.surface.surface2,
      alignItems: "center",
      justifyContent: "center",
    },
    likeBadgeLiked: {
      backgroundColor: theme.colors.brand.primaryLight,
    },
    likeBadgeText: {
      color: theme.colors.text.secondary,
      fontSize: 11,
      fontWeight: "700",
    },
    likeBadgeTextLiked: {
      color: theme.colors.brand.primary,
    },
    stat: {
      color: theme.colors.text.secondary,
      fontSize: 12,
      fontWeight: "700",
    },
    statLiked: {
      color: theme.colors.brand.primary,
    },
    skeletonBlock: {
      backgroundColor: theme.colors.surface.surface2,
    },
    skeletonLine: {
      height: 12,
      borderRadius: 6,
      backgroundColor: theme.colors.surface.surface2,
    },
    swipeArea: {
      position: "absolute",
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      overflow: "hidden",
    },
    swipeMask: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      height: 80,
      background: "linear-gradient(to top, rgba(0,0,0,0.8), transparent)",
      zIndex: 1,
    },
    tipPanel: {
      position: "absolute",
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: "zinc-900",
      borderTopLeftRadius: 12,
      borderTopRightRadius: 12,
      padding: 16,
      paddingBottom: 40,
      zIndex: 10,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.3,
      shadowRadius: 8,
      elevation: 4,
    },
    tipQuickButtons: {
      flexDirection: "row",
      gap: 8,
      marginBottom: 12,
    },
    tipQuickButton: {
      flex: 1,
      backgroundColor: "violet-600",
      borderRadius: 8,
      padding: 8,
      alignItems: "center",
      justifyContent: "center",
    },
    tipQuickButtonText: {
      color: "white",
      fontSize: 12,
      fontWeight: "600",
    },
    tipCustomInput: {
      backgroundColor: "zinc-800",
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      marginBottom: 12,
      color: "white",
      fontSize: 14,
    },
    tipConfirmButton: {
      backgroundColor: "green-600",
      borderRadius: 8,
      padding: 12,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 4,
    },
    tipConfirmButtonDisabled: {
      backgroundColor: "gray-400",
    },
    tipConfirmButtonText: {
      color: "white",
      fontSize: 14,
      fontWeight: "600",
    },
    tipErrorText: {
      color: "red-400",
      fontSize: 12,
      marginBottom: 8,
      marginTop: 4,
    },
  });
}

export function PostCard(props: PostCardProps) {
  const { theme } = useTheme();
  const router = useRouter();
  const { post, timeLabel } = normalizePost(props);
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    // AccessibilityInfo.isReduceMotionEnabled is not available in RN 0.74+
    // but we keep the pattern for future compatibility.
    return undefined;
  }, []);
  const onPress =
    props.onPress ?? (() => router.push(`/post/${post.id}` as Parameters<typeof router.push>[0]));
  const { liked, likeCount, pending, like } = useLike({
    postId: post.id,
    initialHasLiked: post.has_liked ?? false,
    initialLikeCount: post.like_count,
  });

  const { hapticsEnabled } = useHapticSettings();
  const styles = useMemo(() => createStyles(theme), [theme]);

  if ("isLoading" in props && props.isLoading) {
    return <SharedPostCardSkeleton />;
  }

  const handleLikePress = (event: GestureResponderEvent) => {
    if (event && typeof event.stopPropagation === "function") {
      event.stopPropagation();
    }
    if (hapticsEnabled) void impact("light");
    void like();
  };

  // Swipe-to-tip state
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [showTipPanel, setShowTipPanel] = useState(false);
  const [tipAmount, setTipAmount] = useState("0.0");
  const [tipError, setTipError] = useState<string | null>(null);

  const handleSwipe = (event: { translationX: number; state: string }) => {
    const { translationX, state } = event;

    if (state === "end") {
      if (translationX < -SWIPE_THRESHOLD) {
        setShowTipPanel(true);
        setSwipeOffset(0);
      } else {
        setSwipeOffset(withTiming(0));
      }
    } else {
      setSwipeOffset(translationX);
    }
  };

  const handleTipConfirm = async () => {
    setTipError(null);

    const amount = parseFloat(tipAmount);
    if (isNaN(amount) || amount <= 0) {
      setTipError("Please enter a valid amount");
      return;
    }

    // TODO: Implement tip sending with biometric authentication
    // - Use LinkoraClient.tip(tipper, postId, token, amountStroops)
    // - Biometric auth is prompted before signing
    // - Show success haptic + toast on completion

    if (hapticsEnabled) void impact("medium");

    setShowTipPanel(false);
    setSwipeOffset(withTiming(0));
    setTipAmount("0.0");
    setTipError(null);
  };

  const handleTipQuickSelect = (amount: number) => {
    setTipAmount(`${amount.toFixed(1)}`);
  };

  const handleTipDismiss = () => {
    setShowTipPanel(false);
    setSwipeOffset(withTiming(0));
    setTipAmount("0.0");
    setTipError(null);
  };

  return (
    <GestureHandlerRootView>
      <PanGestureHandler
        onHandlerStateChange={handleSwipe}
        maxPointers={1}
        minPointers={1}
      >
        <View
          style={[
            styles.card,
            { transform: [{ translateX: swipeOffset }] },
          ]}
          accessibilityRole="button"
          accessibilityLabel={`Post by ${post.username}`}
        >
          <View style={styles.header}>
            <Pressable
              onPress={() =>
                router.push(`/profile/${post.author}` as Parameters<typeof router.push>[0])
              }
              accessibilityRole="button"
              accessibilityLabel={`Open ${post.username}'s profile`}
            >
              <Animated.View
                style={styles.avatar}
                sharedTransitionTag={undefined}
              >
                <Text style={styles.avatarText}>{post.username.charAt(0).toUpperCase()}</Text>
              </Animated.View>
            </Pressable>
            <View style={styles.meta}>
              <Animated.Text
                style={styles.username}
                sharedTransitionTag={undefined}
              >
                {post.username}
              </Animated.Text>
              <Text style={styles.address}>{shortAddress(post.author)}</Text>
            </View>
            <View style={styles.timeContainer}>
              <Text style={styles.time}>{timeLabel ?? formatTimestamp(post.timestamp)}</Text>
              {post.sync_status === "pending" && <Text style={styles.pendingBadge}>⏳ Syncing</Text>}
              {post.sync_status === "failed" && <Text style={styles.failedBadge}>⚠️ Failed</Text>}
            </View>
          </View>

          <Text style={styles.content}>{post.content}</Text>

          <View style={styles.footer}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                liked
                  ? `Post already liked, ${likeCount} ${likeCount === 1 ? "like" : "likes"}`
                  : `Like post, currently ${likeCount} ${likeCount === 1 ? "like" : "likes"}`
              }
              accessibilityState={{ disabled: liked || pending, selected: liked }}
              disabled={liked || pending}
              onPress={handleLikePress}
              style={({ pressed }) => [
                styles.likeButton,
                liked && styles.likeButtonLiked,
                pressed && !liked && !pending && styles.likeButtonPressed,
              ]}
            >
              <View style={styles.likeInner}>
                <Text style={[styles.likeIcon, liked && styles.likeIconLiked]}>
                  {liked ? "♥" : "♡"}
                </Text>
                <View
                  style={[styles.likeBadge, liked && styles.likeBadgeLiked]}
                  testID="like-count-badge"
                >
                  <Text
                    style={[styles.likeBadgeText, liked && styles.likeBadgeTextLiked]}
                    testID="like-count-text"
                  >
                    {likeCount}
                  </Text>
                </View>
              </View>
            </Pressable>
            <Text style={styles.stat}>💰 {post.tip_total.toFixed(2)}</Text>
          </View>
        </View>

        {/* Tip Panel - revealed on left swipe */}
        {showTipPanel && (
          <Animated.View
            style={[
              styles.tipPanel,
              { transform: [{ translateY: withSpring(0) }] },
            ]}
          >
            <View style={styles.tipQuickButtons}>
              {TIP_QUICK_AMOUNTS.map((amount) => (
                <Pressable
                  key={amount}
                  style={styles.tipQuickButton}
                  onPress={() => handleTipQuickSelect(amount)}
                >
                  <Text style={styles.tipQuickButtonText}>{amount} XLM</Text>
                </Pressable>
              ))}
            </View>

            <View style={styles.tipCustomInput}>
              <Text style={styles.tipQuickButtonText}>Custom amount</Text>
              <TextInput
                style={styles.tipCustomInput}
                value={tipAmount}
                onChangeText={(text) => setTipAmount(text)}
                keyboardType="decimal-pad"
                placeholder="0.0"
                autoCapitalize="none"
              />
            </View>

            <Pressable
              style={styles.tipConfirmButton}
              onPress={handleTipConfirm}
              disabled={tipError !== null}
            >
              <Text style={styles.tipConfirmButtonText}>
                {tipError ? "Invalid amount" : "Send tip"}
              </Text>
            </Pressable>

            {tipError && (
              <Text style={styles.tipErrorText}>{tipError}</Text>
            )}

            <Pressable
              style={{ padding: 8, alignItems: "center" }}
              onPress={handleTipDismiss}
            >
              <Text style={{ color: "gray", fontSize: 12 }}>Cancel</Text>
            </Pressable>
          </Animated.View>
        )}
      </PanGestureHandler>
    </GestureHandlerRootView>
  );
}

export default PostCard;