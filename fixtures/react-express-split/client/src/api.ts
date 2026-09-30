import axios from 'axios';

export interface Bookmark {
  id: number;
  title: string;
  url: string;
}

const api = axios.create({ baseURL: import.meta.env.VITE_API_URL });

export const listBookmarks = () => api.get<Bookmark[]>('/bookmarks').then((r) => r.data);
export const addBookmark = (title: string, url: string) => api.post<Bookmark>('/bookmarks', { title, url }).then((r) => r.data);
